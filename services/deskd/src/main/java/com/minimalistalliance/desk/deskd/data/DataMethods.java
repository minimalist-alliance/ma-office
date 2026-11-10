package com.minimalistalliance.desk.deskd.data;

import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;

/**
 * The data.* RPCs (API.md section 12), for the owner's sessions and export ones. What the helper says goes through as
 * it is, as desk-data is the desk's own root code, and only its shape is checked. deskd checks what a client sends
 * before the helper hears it, and the helper checks it again.
 *
 * <p><b>The Platform's bandwidth pause</b> refuses a new data.read from an {@code owner} session only. An {@code export}
 * session's is never refused for it, past {@link FreeBudget} included, as a paused member must always be able to take
 * their data away (Security's NE-1): refusing it there used to end a download "done" with every file it hadn't reached
 * skipped. Past the budget its bytes still reach the meter, as {@link Transfers} leaves them out of {@link FreeBytes},
 * and the Platform's cost guard and the desk's throttle (ADR 0036) bound what they can cost. What's already running
 * finishes, and the metadata calls and holds are never refused.
 */
final class DataMethods {

    static final String INVALID = "invalid";
    private static final String BANDWIDTH_LIMIT = "bandwidth_limit";
    /** The Appendix's page. */
    static final int MANIFEST_PAGE = 2000;
    /** A page whose reply wouldn't fit a RES is asked for again this many times smaller. */
    private static final int PAGE_SHRINK = 4;
    private static final int MAX_PART_BYTES = 255;
    private static final int MAX_CURSOR_CHARS = 16 * 1024;
    /**
     * Top-level directories of /data that belong to the machine, not the member (the draft, decision 4): the desk's
     * DTLS identity, a self-hosted desk's key and pairing (task 31), the throttle's budgets, and what isn't data. The
     * helper leaves them out too. deskd never lists, reads or pages one, whatever the helper says, as a key must never
     * leave its desk.
     */
    static final Set<String> MACHINE_PARTS = Set.of("rtc", "selfhost", "desk-egress", "lost+found", ".ma-export-tmp", ".ma-move");

    /** The Browser's side of data.browser.cookies. */
    @FunctionalInterface
    interface Cookies {
        List<Map<String, Object>> read() throws RpcException, InterruptedException;
    }

    private final DataHelperClient helper;
    private final Transfers transfers;
    private final BrowserHold hold;
    private final Cookies cookies;
    private volatile Supplier<Instant> pausedUntil = () -> null;

    DataMethods(DataHelperClient helper, Transfers transfers, BrowserHold hold, Cookies cookies) {
        this.helper = helper;
        this.transfers = transfers;
        this.hold = hold;
        this.cookies = cookies;
    }

    /**
     * Where the Platform's bandwidth pause comes from: when it ends, {@link Instant#MAX} if the Platform didn't say, or
     * null while there's none. Set once, before anything can call.
     */
    void pauseFrom(Supplier<Instant> until) {
        pausedUntil = until;
    }

    void register(RpcDispatcher dispatcher) {
        dispatcher.register("data.parts.list", RpcDispatcher.OWNER_OR_EXPORT, this::partsList);
        dispatcher.register("data.manifest", RpcDispatcher.OWNER_OR_EXPORT, this::manifest);
        dispatcher.register("data.read", RpcDispatcher.OWNER_OR_EXPORT, this::read);
        dispatcher.register("data.read.stop", RpcDispatcher.OWNER_OR_EXPORT, this::readStop);
        dispatcher.registerSessionMutation("data.browser.hold", RpcDispatcher.OWNER_OR_EXPORT, this::browserHold);
        dispatcher.registerMutation("data.browser.keep", RpcDispatcher.OWNER_OR_EXPORT, this::browserKeep);
        dispatcher.registerMutation("data.browser.release", RpcDispatcher.OWNER_OR_EXPORT, this::browserRelease);
        dispatcher.register("data.browser.cookies", RpcDispatcher.OWNER_OR_EXPORT, this::browserCookies);
    }

    private Object partsList(RpcContext context, Map<String, Object> params) throws Exception {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("v", 1);
        request.put("op", "parts");
        Map<String, Object> reply = ask(request, FrameKind.RES.maxMessageBytes());
        if (!(reply.get("parts") instanceof List<?> listed)) {
            throw helperUnavailable();
        }
        List<Object> parts = new ArrayList<>(listed.size());
        for (Object item : listed) {
            if (!(item instanceof Map<?, ?> entry && entry.get("part") instanceof String name && MACHINE_PARTS.contains(name))) {
                parts.add(item);
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("parts", parts);
        result.put("helperVersion", Json.string(reply, "helperVersion"));
        return result;
    }

    private Object manifest(RpcContext context, Map<String, Object> params) throws Exception {
        String part = part(params);
        Object cursor = params.get("cursor");
        if (cursor != null && (!(cursor instanceof String text) || text.length() > MAX_CURSOR_CHARS)) {
            throw new RpcException(RpcException.BAD_REQUEST, "cursor must be a string or null", Map.of("reason", "cursor"));
        }
        // A page of long paths could be past what a RES carries, so a smaller one is asked for. 2000, 500, 125, 31, 7, 1.
        for (int limit = MANIFEST_PAGE; limit > 0; limit /= PAGE_SHRINK) {
            Map<String, Object> request = new LinkedHashMap<>();
            request.put("v", 1);
            request.put("op", "manifest");
            request.put("part", part);
            request.put("cursor", cursor);
            request.put("limit", limit);
            Map<String, Object> reply;
            try {
                reply = helper.call(request, FrameKind.RES.maxMessageBytes());
            } catch (HelperException e) {
                if (HelperException.REPLY_TOO_LONG.equals(e.code())) {
                    continue;
                }
                throw toRpc(e);
            }
            if (!(reply.get("entries") instanceof List<?> entries) || entries.size() > limit) {
                throw helperUnavailable();
            }
            Object next = reply.get("next");
            if (next != null && !(next instanceof String)) {
                throw helperUnavailable();
            }
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("entries", entries);
            result.put("next", next);
            if (Json.bytes(result).length <= FrameKind.RES.maxMessageBytes()) {
                return result;
            }
        }
        throw helperUnavailable();
    }

    private Object read(RpcContext context, Map<String, Object> params) throws Exception {
        String part = part(params);
        String path = path(params);
        long offset = 0;
        if (params.get("offset") != null) {
            offset = DataHelperClient.wholeNumber(params.get("offset"));
            if (offset < 0) {
                throw new RpcException(RpcException.BAD_REQUEST, "offset must be a whole number", Map.of("reason", "offset"));
            }
        }
        RpcPrincipal principal = context.principal();
        refuseIfPaused(principal);
        String sessionId = principal.sessionId();
        Transfer transfer = transfers.reserve(sessionId);
        DataHelperClient.Read body;
        try {
            body = helper.read(part, path, offset);
        } catch (HelperException e) {
            transfer.stop();
            throw toRpc(e);
        } catch (InterruptedException | RuntimeException e) {
            transfer.stop();
            throw e;
        }
        if (!transfer.attach(body)) {
            throw new RpcException(RpcException.UNAVAILABLE, "The session has ended", Map.of());
        }
        // CHUNKs follow the reply. Channels aren't ordered against each other, so a reader still keeps any that come
        // first, but most won't have to.
        // A call that ended first (cancel, deadline) starts nothing, and frees the slot.
        context.afterReply(transfer::start, transfer::stop);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("transferId", transfer.id());
        result.put("size", body.size());
        result.put("mtimeMs", body.mtimeMs());
        return result;
    }

    /**
     * As the Browser's {@code live} is refused, with the same details (API.md sections 10 and 12), for an {@code owner}
     * session. Never for an {@code export} one, whatever is left of the free budget.
     */
    private void refuseIfPaused(RpcPrincipal principal) throws RpcException {
        Instant until = pausedUntil.get();
        if (until == null || RpcPrincipal.EXPORT.equals(principal.scope())) {
            return;
        }
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("reason", BANDWIDTH_LIMIT);
        details.put("resumesAt", until.equals(Instant.MAX) ? null : until.toString());
        throw new RpcException(RpcException.UNAVAILABLE, "Paused at the bandwidth limit", details);
    }

    private Object readStop(RpcContext context, Map<String, Object> params) throws Exception {
        long transferId = DataHelperClient.wholeNumber(params.get("transferId"));
        if (transferId < 0) {
            throw new RpcException(RpcException.BAD_REQUEST, "transferId must be a whole number", Map.of("reason", "transferId"));
        }
        transfers.stop(context.principal().sessionId(), transferId);
        return Map.of();
    }

    private Object browserHold(RpcContext context, Map<String, Object> params) throws Exception {
        context.beginEffect();
        return hold.hold(context.principal().sessionId());
    }

    /** Its effect outlasts the session, so it isn't a session mutation: a retry from another session gets the same reply. */
    private Object browserKeep(RpcContext context, Map<String, Object> params) throws Exception {
        context.beginEffect();
        return hold.keep(context.principal().sessionId());
    }

    /**
     * This session's hold, and with {@code kept: true} a move's kept hold too, which only the owner may let go of: an
     * {@code export} session is a download or a move, never the member saying so (NE-2).
     */
    private Object browserRelease(RpcContext context, Map<String, Object> params) throws Exception {
        Object kept = params.get("kept");
        if (kept != null && !(kept instanceof Boolean)) {
            throw new RpcException(RpcException.BAD_REQUEST, "kept must be true or false", Map.of("reason", "kept"));
        }
        boolean releaseKept = Boolean.TRUE.equals(kept);
        if (releaseKept && !RpcPrincipal.OWNER.equals(context.principal().scope())) {
            throw new RpcException(RpcException.FORBIDDEN, "Only the owner can let go of a moved desk's Browser", Map.of("reason", "scope"));
        }
        context.beginEffect();
        RpcPrincipal principal = context.principal();
        if (releaseKept) {
            hold.releaseKept();
        }
        return hold.release(principal.sessionId());
    }

    private Object browserCookies(RpcContext context, Map<String, Object> params) throws Exception {
        return CookieDigests.of(cookies.read());
    }

    private Map<String, Object> ask(Map<String, Object> request, int maxReplyBytes) throws RpcException, InterruptedException {
        try {
            return helper.call(request, maxReplyBytes);
        } catch (HelperException e) {
            throw toRpc(e);
        }
    }

    /** A part is a top-level directory's name. */
    private static String part(Map<String, Object> params) throws RpcException {
        if (!(params.get("part") instanceof String part)) {
            throw new RpcException(RpcException.BAD_REQUEST, "part must be a string", Map.of("reason", "part"));
        }
        if (part.isEmpty()
                || part.getBytes(StandardCharsets.UTF_8).length > MAX_PART_BYTES
                || part.equals(".")
                || part.equals("..")
                || part.indexOf('/') >= 0
                || part.indexOf('\0') >= 0) {
            throw invalid("part");
        }
        if (MACHINE_PARTS.contains(part)) {
            throw new RpcException(RpcException.NOT_FOUND, "No such part or path", Map.of());
        }
        return part;
    }

    /** Relative to the part, /-separated, with no empty, . or .. component. The helper confines it again. */
    private static String path(Map<String, Object> params) throws RpcException {
        if (!(params.get("path") instanceof String path)) {
            throw new RpcException(RpcException.BAD_REQUEST, "path must be a string", Map.of("reason", "path"));
        }
        if (path.isEmpty() || path.indexOf('\0') >= 0) {
            throw invalid("path");
        }
        for (String component : path.split("/", -1)) {
            if (component.isEmpty() || component.equals(".") || component.equals("..")) {
                throw invalid("path");
            }
        }
        return path;
    }

    private static RpcException invalid(String reason) {
        return new RpcException(INVALID, "Not a path deskd can read", Map.of("reason", reason));
    }

    private static RpcException helperUnavailable() {
        return new RpcException(RpcException.UNAVAILABLE, "The desk's data helper isn't available", Map.of("reason", "helper"));
    }

    /** The helper's codes, as a client sees them. Its message never goes out, as it can name a file. */
    static RpcException toRpc(HelperException e) {
        return switch (e.code()) {
            case HelperException.NOT_FOUND -> new RpcException(RpcException.NOT_FOUND, "No such part or path", Map.of());
            case HelperException.INVALID -> new RpcException(INVALID, "Not a path deskd can read", Map.of());
            case HelperException.BAD_REQUEST -> new RpcException(RpcException.BAD_REQUEST, "The helper refused the request", Map.of());
            // The request line is over 4,096 bytes, as a very long path or cursor makes it.
            case HelperException.REQUEST_TOO_LONG -> new RpcException(INVALID, "Too long for the helper", Map.of("reason", "length"));
            default -> helperUnavailable();
        };
    }
}
