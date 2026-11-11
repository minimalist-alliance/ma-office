package com.minimalistalliance.desk.deskd.browser.minified;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Semaphore;
import java.util.regex.Pattern;

/**
 * The simplified view's RPCs (API.md section 14). Every one is the owner's alone, as the dispatcher's default is, so an
 * {@code export} session gets {@code forbidden} with {@code reason: scope} before anything here runs. What a page shows
 * needs a token with video; anything that changes the page or the site's memory needs input as well.
 */
final class MinifiedMethods {

    /** An image's bytes, under a RES's 1 MiB once base64 has made them a third bigger. */
    static final int MAX_IMAGE_BYTES = 700 * 1024;
    private static final int IMAGES_AT_ONCE = 2;
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9._~-]{1,128}");

    private final MinifiedModule module;
    private final ActionProxy proxy;
    /** Each image read holds a few MB while it's decoded, so only so many at once. */
    private final Semaphore images = new Semaphore(IMAGES_AT_ONCE, true);

    MinifiedMethods(MinifiedModule module, ActionProxy proxy) {
        this.module = module;
        this.proxy = proxy;
    }

    void register(RpcDispatcher dispatcher) {
        dispatcher.register("browser.minified.get", this::get);
        dispatcher.registerMutation("browser.minified.act", this::act);
        dispatcher.register("browser.minified.image", this::image);
        dispatcher.register("browser.minified.island", this::island);
        // No idem: setting the same thing twice is harmless, and the last one wins.
        dispatcher.register("browser.minified.site.get", this::siteGet);
        dispatcher.register("browser.minified.site.set", this::siteSet);
        dispatcher.register("browser.minified.sites.list", this::sitesList);
        dispatcher.register("browser.minified.sites.clear", this::sitesClear);
        dispatcher.registerMutation("browser.adblock.site.set", this::adblockSet);
    }

    private Object get(RpcContext context, Map<String, Object> params) throws Exception {
        requireOn();
        requireVideo(context);
        module.requireTime();
        Object since = params.get("since");
        if (since != null && !(since instanceof Number)) {
            throw badRequest("since");
        }
        Object retry = params.get("retry");
        if (retry != null && !(retry instanceof Boolean)) {
            throw badRequest("retry");
        }
        Object reply = module.get(optionalId(params, "tabId"), since == null ? null : ((Number) since).longValue(), Boolean.TRUE.equals(retry));
        module.used();
        return reply;
    }

    private Object act(RpcContext context, Map<String, Object> params) throws Exception {
        requireOn();
        requireInput(context);
        module.requireTime();
        ActionProxy.Request request = new ActionProxy.Request(
                requiredId(params, "tabId"),
                requiredId(params, "nodeId"),
                requiredString(params, "action", 16),
                params.get("value"),
                requiredString(params, "fp", 32),
                requiredString(params, "block", 32),
                requiredRev(params));
        Object reply = proxy.act(context, request);
        module.used();
        return reply;
    }

    /**
     * An image of the page, from what the tab already loaded: Chromium's own copy, never a fetch by deskd, and never
     * decoded here (Security T47-5). Only PNG, JPEG, GIF, WebP and AVIF go out.
     */
    private Object image(RpcContext context, Map<String, Object> params) throws Exception {
        requireOn();
        requireVideo(context);
        module.requireTime();
        String imageId = requiredId(params, "imageId");
        String tabId = requiredId(params, "tabId");
        // Work: Chromium is thawed for it first (ADR 0045).
        try (AutoCloseable use = module.access.use()) {
            Map<String, Object> reply = image(tabId, imageId);
            module.used();
            return reply;
        } catch (RpcException | InterruptedException e) {
            throw e;
        } catch (Exception e) {
            throw MinifiedModule.unavailable();
        }
    }

    private Map<String, Object> image(String tabId, String imageId) throws RpcException, InterruptedException {
        TabRef tab = module.access.resolve(tabId);
        MinifiedModule.TabState state = module.existing(tab.tabId());
        String url = state == null ? null : module.imageUrl(state, imageId);
        if (url == null) {
            throw notFound("image");
        }
        byte[] bytes;
        images.acquire();
        try {
            bytes = url.startsWith("data:") ? Base64.getDecoder().decode(url.substring(url.indexOf(',') + 1)) : loaded(tab, url);
        } catch (IllegalArgumentException e) {
            throw notFound("image");
        } catch (RpcException | InterruptedException e) {
            throw e;
        } catch (Exception e) {
            throw MinifiedModule.unavailable();
        } finally {
            images.release();
        }
        if (bytes.length > MAX_IMAGE_BYTES) {
            throw new RpcException(RpcException.TOO_LARGE, "Image too large", Map.of("limit", MAX_IMAGE_BYTES));
        }
        String mime = ImageBytes.sniff(bytes);
        if (mime == null) {
            throw notFound("image_type");
        }
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("imageId", imageId);
        reply.put("mime", mime);
        reply.put("data", Base64.getEncoder().encodeToString(bytes));
        return reply;
    }

    private byte[] loaded(TabRef tab, String url) throws RpcException, InterruptedException {
        Map<String, Object> content;
        try {
            content = module.access.callLong(tab, "Page.getResourceContent",
                    Map.of("frameId", tab.mainFrameId(), "url", url), module.timing.request());
        } catch (CdpFailure e) {
            // REMOTE: not something the page loaded, or not any more. deskd never fetches it instead.
            throw e.kind() == CdpFailure.Kind.REMOTE ? notFound("image") : MinifiedModule.unavailable();
        }
        String body = Json.string(content, "content");
        if (body == null || !Boolean.TRUE.equals(content.get("base64Encoded"))) {
            throw notFound("image_type");
        }
        if (body.length() > MAX_IMAGE_BYTES / 3 * 4 + 4) {
            throw new RpcException(RpcException.TOO_LARGE, "Image too large", Map.of("limit", MAX_IMAGE_BYTES));
        }
        return Base64.getDecoder().decode(body);
    }

    /**
     * An island's box on the real page now, scrolled into view, clamped to the viewport, with an epoch that changes
     * whenever the box does, for the cropped encoder and the renderer (T47-4's desk part). {@code live} says whether
     * streaming it is safe: its tab is on screen, it's visible, nothing else is drawn over its middle, and nothing is
     * fullscreen.
     */
    private Object island(RpcContext context, Map<String, Object> params) throws Exception {
        requireOn();
        requireInput(context);
        module.requireTime();
        String islandId = requiredId(params, "islandId");
        String tabId = requiredId(params, "tabId");
        // Work: Chromium is thawed for it first (ADR 0045).
        try (AutoCloseable use = module.access.use()) {
            Map<String, Object> reply = island(tabId, islandId);
            module.used();
            return reply;
        } catch (RpcException | InterruptedException e) {
            throw e;
        } catch (Exception e) {
            throw MinifiedModule.unavailable();
        }
    }

    private Map<String, Object> island(String tabId, String islandId) throws RpcException, InterruptedException {
        TabRef tab = module.access.resolve(tabId);
        MinifiedModule.TabState state = module.existing(tab.tabId());
        MDoc doc = state == null ? null : module.doc(state);
        if (doc == null || !doc.islands.containsKey(islandId)) {
            throw notFound("island");
        }
        Map<String, Object> box;
        try {
            box = module.world.run(tab, Map.of("op", "island", "island", islandId, "scroll", true), module.timing.request());
        } catch (CdpFailure e) {
            throw MinifiedModule.unavailable();
        } catch (InterruptedException e) {
            throw e;
        } catch (Exception e) {
            throw MinifiedModule.unavailable();
        }
        if (Boolean.TRUE.equals(box.get("gone")) || box.get("error") != null) {
            throw notFound("island");
        }
        Map<String, Object> rect = new LinkedHashMap<>();
        rect.put("x", round(box.get("x")));
        rect.put("y", round(box.get("y")));
        rect.put("width", round(box.get("width")));
        rect.put("height", round(box.get("height")));
        Map<String, Object> viewport = new LinkedHashMap<>();
        viewport.put("width", round(box.get("vw")));
        viewport.put("height", round(box.get("vh")));
        double dpr = box.get("dpr") instanceof Number n ? Math.max(0.25, Math.min(8, n.doubleValue())) : 1;
        long epoch = module.islandEpoch(state, islandId, rect + " " + viewport + " " + dpr);
        boolean active = module.access.isActive(tab.tabId());
        String reason = !active ? "not_active"
                : !Boolean.TRUE.equals(box.get("visible")) ? "hidden"
                : Boolean.TRUE.equals(box.get("covered")) ? "covered"
                : Boolean.TRUE.equals(box.get("wall")) ? "wall"
                : Boolean.TRUE.equals(box.get("fullscreen")) ? "fullscreen"
                : null;
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("islandId", islandId);
        reply.put("kind", doc.islands.get(islandId).kind());
        reply.put("epoch", epoch);
        reply.put("live", reason == null);
        if (reason != null) {
            reply.put("reason", reason);
        }
        reply.put("rect", rect);
        reply.put("viewport", viewport);
        reply.put("dpr", dpr);
        if (box.get("playing") instanceof Boolean playing) {
            reply.put("playing", playing);
        }
        if (box.get("muted") instanceof Boolean muted) {
            reply.put("muted", muted);
        }
        return reply;
    }

    private static long round(Object raw) {
        return raw instanceof Number n && !Double.isNaN(n.doubleValue()) ? Math.round(Math.max(0, Math.min(100_000, n.doubleValue()))) : 0;
    }

    // ---- the site's memory (T47-9: it's here, on the desk, and the office keeps none of it)

    private Object siteGet(RpcContext context, Map<String, Object> params) throws Exception {
        requireOn();
        requireVideo(context);
        return module.memory.get(host(params)).wire();
    }

    private Object siteSet(RpcContext context, Map<String, Object> params) throws Exception {
        requireOn();
        requireInput(context);
        String host = host(params);
        SiteMemory.View view = null;
        if (params.containsKey("view") && params.get("view") != null) {
            view = SiteMemory.View.parse(params.get("view"));
            if (view == null) {
                throw badRequest("view");
            }
        }
        Object sensitive = params.get("sensitive");
        if (sensitive != null && !(sensitive instanceof Boolean)) {
            throw badRequest("sensitive");
        }
        // Signals only add (T47-7): a site on the shipped list stays sensitive whatever's set here.
        SiteMemory.Site site = module.memory.set(host, params.containsKey("view"), view, (Boolean) sensitive);
        module.siteChanged(host);
        return site.wire();
    }

    private Object sitesList(RpcContext context, Map<String, Object> params) throws Exception {
        requireOn();
        requireVideo(context);
        List<Map<String, Object>> sites = new ArrayList<>();
        for (SiteMemory.Site site : module.memory.list()) {
            sites.add(site.wire());
        }
        return Map.of("sites", sites);
    }

    /**
     * Forgets every site, the ad-blocking off list included (T47S-3): what the member's clear-history calls. It works
     * with the view switched off too, as it touches only deskd's own files.
     */
    private Object sitesClear(RpcContext context, Map<String, Object> params) throws Exception {
        requireInput(context);
        List<String> sites = new ArrayList<>(module.adblock.list());
        for (SiteMemory.Site site : module.memory.list()) {
            sites.add(site.host());
        }
        try {
            module.adblock.clear();
        } catch (java.io.IOException e) {
            throw storage();
        }
        module.memory.clear();
        for (String site : sites) {
            module.siteChanged(site);
        }
        return Map.of();
    }

    /**
     * Turns ad blocking off ({@code on: false}) or back on for a site, its registrable domain, as ADR 0073's per-site
     * switch: deskd keeps the list, and the image's blocklist reads it into Chromium's policy.
     */
    private Object adblockSet(RpcContext context, Map<String, Object> params) throws Exception {
        requireInput(context);
        if (!(params.get("on") instanceof Boolean on)) {
            throw badRequest("on");
        }
        String site;
        try {
            site = module.adblock.set(host(params), on);
        } catch (java.io.IOException e) {
            throw storage();
        }
        module.siteChanged(site);
        return Map.of("host", site, "on", on);
    }

    private static RpcException storage() {
        return new RpcException(RpcException.UNAVAILABLE, "The desk couldn't keep it", Map.of("reason", "storage"));
    }

    /** {@code host}, or the host of {@code tabId}'s page, or of the tab on screen. */
    private String host(Map<String, Object> params) throws RpcException, InterruptedException {
        Object host = params.get("host");
        if (host != null) {
            if (!(host instanceof String h) || !SiteMemory.isHost(h)) {
                throw badRequest("host");
            }
            return h;
        }
        String tabId = optionalId(params, "tabId");
        String url;
        try (AutoCloseable use = module.access.use()) {
            url = module.access.resolve(tabId).url();
        } catch (RpcException | InterruptedException e) {
            throw e;
        } catch (Exception e) {
            throw MinifiedModule.unavailable();
        }
        String fromTab = SiteMemory.hostOf(url);
        if (fromTab == null) {
            throw new RpcException(RpcException.BAD_REQUEST, "The tab isn't on a web page", Map.of("reason", "host"));
        }
        return fromTab;
    }

    // ---- params

    private static String optionalId(Map<String, Object> params, String name) throws RpcException {
        Object raw = params.get(name);
        if (raw == null) {
            return null;
        }
        if (!(raw instanceof String id) || !ID.matcher(id).matches()) {
            throw badRequest(name);
        }
        return id;
    }

    private static String requiredId(Map<String, Object> params, String name) throws RpcException {
        String id = optionalId(params, name);
        if (id == null) {
            throw badRequest(name);
        }
        return id;
    }

    private static String requiredString(Map<String, Object> params, String name, int max) throws RpcException {
        if (!(params.get(name) instanceof String value) || value.isEmpty() || value.length() > max) {
            throw badRequest(name);
        }
        return value;
    }

    private static long requiredRev(Map<String, Object> params) throws RpcException {
        if (!(params.get("rev") instanceof Number rev) || rev.longValue() < 1) {
            throw badRequest("rev");
        }
        return rev.longValue();
    }

    private static void requireVideo(RpcContext context) throws RpcException {
        if (!context.principal().video()) {
            throw forbidden();
        }
    }

    private static void requireInput(RpcContext context) throws RpcException {
        if (!context.principal().video() || !context.principal().input()) {
            throw forbidden();
        }
    }

    /** Off on this desk (MinifiedSwitch): every method says so, before anything else. */
    private void requireOn() throws RpcException {
        if (!module.flags.on()) {
            throw disabled();
        }
    }

    static RpcException disabled() {
        return new RpcException(RpcException.UNAVAILABLE, "The simplified view is off on this desk", Map.of("reason", "disabled"));
    }

    /**
     * Today's Browser time on a free desk is used up (ADR 0090): the live refusal's own shape, so every Desk app pauses
     * as it does for that. {@code resumesAt} is the member's next midnight.
     */
    static RpcException timeUsed(Instant resumesAt) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("reason", "bandwidth_limit");
        details.put("resumesAt", resumesAt.toString());
        details.put("limit", "browser_time");
        return new RpcException(RpcException.UNAVAILABLE, "Today's Browser time is used up", details);
    }

    static RpcException forbidden() {
        return new RpcException(RpcException.FORBIDDEN, "The token doesn't allow this", Map.of("reason", "permission"));
    }

    private static RpcException badRequest(String reason) {
        return new RpcException(RpcException.BAD_REQUEST, "Bad " + reason, Map.of("reason", reason));
    }

    private static RpcException notFound(String reason) {
        return new RpcException(RpcException.NOT_FOUND, "Not found", Map.of("reason", reason));
    }
}
