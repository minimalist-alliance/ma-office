package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.notebook.NotebookCalls;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

/**
 * The Notebook area of the Agent's tools (draft ADR "the Agent's tools and approvals", sections 2 and 8; API.md section
 * 18): {@code notebook_search}, {@code notebook_read}, {@code notebook_write} and {@code notebook_trash}, on the desk's
 * Notebook through desk-notebook, as {@code call.caller()}: deskd's own stamp, the desk's owner, or on a guild desk the
 * member whose agent it is, never anything desk-agent sent. desk-notebook checks every call as it checks that member's
 * own session ({@link NotebookCalls}): their grants, the edit budget, the rules for a page in the Trash, page_full.
 *
 * <p>A write's look asks desk-notebook for a dry run of exactly the payload, so the card has the page's title and an
 * edit that would be refused anyway (a {@code find} that isn't there or is there twice, past the edit budget, a page in
 * the Trash) is refused before anyone is asked. The look before a run asks nothing: the run is checked again where it
 * happens. An edit is "Edited by" the agent by its id, which the desk app shows as the agent's name; deskd keeps none.
 * Trash only: restoring stays the member's.
 *
 * <p>On a guild desk every result adds U, as guild content came from other members. Nothing here logs or puts in a
 * {@link ToolFailure} any page text, title, query or Markdown: desk-notebook's refusal words only.
 */
public final class NotebookTools implements HostedTool {

    /** Hits a search gives the model, at most. */
    static final int SEARCH_MAX = 20;
    /** The most Markdown one write takes. */
    static final int MARKDOWN_MAX = 65_536;
    /** A search's words, as desk-notebook takes them. */
    static final int QUERY_MAX = 4096;
    /** A new page's title: its first line. */
    static final int TITLE_MAX = 1024;
    private static final Set<String> OPS = Set.of("create", "append", "replace_text");
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9_.:-]{1,128}");
    /** desk-notebook's refusal words; anything else it says is not passed on. */
    private static final Pattern WORD = Pattern.compile("[a-z][a-z_]{0,31}");

    private final NotebookCalls notebook;
    private final BooleanSupplier guildDesk;

    /**
     * @param notebook deskd's own calls to desk-notebook
     * @param guildDesk whether this is a guild desk, where every result is untrusted content
     */
    public NotebookTools(NotebookCalls notebook, BooleanSupplier guildDesk) {
        this.notebook = notebook;
        this.guildDesk = guildDesk;
    }

    @Override
    public boolean available() {
        return notebook.configured();
    }

    @Override
    public Look look(HostedCall call, RunLedger.Run run) throws ToolFailure, InterruptedException {
        return switch (call.tool()) {
            case "notebook_search" -> Look.plain(searchPayload(call.args()), null);
            case "notebook_read" -> {
                Map<String, Object> payload = readPayload(call.args());
                yield Look.plain(payload, target((String) payload.get("pageId"), null));
            }
            case "notebook_write" -> lookWrite(call);
            case "notebook_trash" -> lookTrash(call);
            default -> throw ToolFailure.notFound("tool");
        };
    }

    private Look lookWrite(HostedCall call) throws ToolFailure, InterruptedException {
        Map<String, Object> payload = writePayload(call.args());
        String pageId = (String) payload.get("pageId");
        @SuppressWarnings("unchecked")
        Map<String, Object> made = (Map<String, Object>) payload.get("new");
        Map<String, Object> target = target(pageId, made == null ? null : (String) made.get("title"));
        if (!call.look()) {
            return new Look(ToolRisk.WRITE, "agent", target, payload, null, null);
        }
        // The card's look: desk-notebook's dry run of exactly this, as the member it runs as.
        Map<String, Object> dry = new LinkedHashMap<>(payload);
        dry.put("agentName", call.agentId());
        dry.put("dryRun", true);
        Map<String, Object> r = object(ask(call, "notebook.page.agentEdit", dry, false));
        Map<String, Object> before = null;
        if (pageId != null) {
            String title = r.get("title") instanceof String t ? t : "";
            target.put("title", title);
            before = new LinkedHashMap<>();
            before.put("title", title);
        }
        return new Look(ToolRisk.WRITE, "agent", target, payload, before, null);
    }

    private Look lookTrash(HostedCall call) throws ToolFailure, InterruptedException {
        String pageId = pageId(call.args());
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("pageId", pageId);
        Map<String, Object> target = target(pageId, null);
        if (!call.look()) {
            return new Look(ToolRisk.DELETE, "agent", target, payload, null, null);
        }
        // The page's title for the card, read as the member: a page they can't read, they can't be asked about.
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("pageId", pageId);
        params.put("max", 0);
        Map<String, Object> r = object(ask(call, "notebook.page.markdown", params, false));
        if (Boolean.TRUE.equals(r.get("trashed"))) {
            throw ToolFailure.refused("trashed");
        }
        String title = r.get("title") instanceof String t ? t : "";
        target.put("title", title);
        Map<String, Object> before = new LinkedHashMap<>();
        before.put("title", title);
        return new Look(ToolRisk.DELETE, "agent", target, payload, before, null);
    }

    @Override
    public Result run(HostedCall call, RunLedger.Run run) throws ToolFailure, InterruptedException {
        Set<String> taints = guildDesk.getAsBoolean() ? Set.of("U") : Set.of();
        return switch (call.tool()) {
            case "notebook_search" -> {
                Map<String, Object> payload = searchPayload(call.args());
                Map<String, Object> params = new LinkedHashMap<>(payload);
                params.putIfAbsent("limit", SEARCH_MAX);
                Map<String, Object> r = object(ask(call, "notebook.search", params, false));
                List<Object> hits = new ArrayList<>();
                if (r.get("hits") instanceof List<?> list) {
                    for (Object o : list) {
                        if (hits.size() == SEARCH_MAX) {
                            break;
                        }
                        if (o instanceof Map<?, ?> hit) {
                            Map<String, Object> m = new LinkedHashMap<>();
                            m.put("pageId", hit.get("pageId"));
                            m.put("title", hit.get("title"));
                            m.put("snippet", hit.get("snippet"));
                            hits.add(m);
                        }
                    }
                }
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("hits", hits);
                yield new Result(out, taints, Map.of());
            }
            case "notebook_read" -> {
                Map<String, Object> r = object(ask(call, "notebook.page.markdown", readPayload(call.args()), false));
                Map<String, Object> out = new LinkedHashMap<>();
                for (String key : List.of("pageId", "title", "markdown", "from", "next", "length", "trashed")) {
                    out.put(key, r.get(key));
                }
                if (r.get("next") != null) {
                    out.put("note", "There is more of the page: read it again with from set to next.");
                }
                yield new Result(out, taints, Map.of());
            }
            case "notebook_write" -> {
                Map<String, Object> params = new LinkedHashMap<>(writePayload(call.args()));
                params.put("agentName", call.agentId());
                Map<String, Object> r = object(ask(call, "notebook.page.agentEdit", params, true));
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("pageId", r.get("pageId"));
                out.put("title", r.get("title"));
                out.put("op", r.get("op"));
                out.put("saved", true);
                if (r.get("versionId") != null) {
                    out.put("versionId", r.get("versionId"));
                    out.put("note", "The page as it was before is a version in its history, so the member can go back to it.");
                }
                yield new Result(out, taints, Map.of());
            }
            case "notebook_trash" -> {
                String pageId = pageId(call.args());
                Map<String, Object> params = new LinkedHashMap<>();
                params.put("pageId", pageId);
                ask(call, "notebook.page.trash", params, true);
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("trashed", pageId);
                out.put("note", "In the Notebook's Trash for 30 days, where the member can restore it.");
                yield new Result(out, taints, Map.of());
            }
            default -> throw ToolFailure.notFound("tool");
        };
    }

    private Object ask(HostedCall call, String method, Map<String, Object> params, boolean mutation)
            throws ToolFailure, InterruptedException {
        try {
            return notebook.call(call.caller(), method, params, mutation);
        } catch (RpcException e) {
            throw failure(e);
        }
    }

    /** desk-notebook's refusal as a tool's: its code and word, never its message or anything else it sent. */
    static ToolFailure failure(RpcException e) {
        Map<String, Object> details = e.details() == null ? Map.of() : e.details();
        String word = details.get("reason") instanceof String r && WORD.matcher(r).matches() ? r : null;
        return switch (e.code()) {
            case RpcException.UNAVAILABLE -> word == null || "notebook".equals(word)
                    ? new ToolFailure(RpcException.UNAVAILABLE, "notebook",
                            Boolean.TRUE.equals(details.get("mayHaveApplied")) ? Map.of("mayHaveApplied", true) : Map.of())
                    : ToolFailure.unavailable(word);
            // A desk-notebook from before these methods says so of the method, not of a page: it's not there for this yet.
            case RpcException.NOT_FOUND -> "method".equals(word) ? ToolFailure.unavailable("notebook") : ToolFailure.notFound("not_found");
            case RpcException.TOO_LARGE -> new ToolFailure(RpcException.TOO_LARGE, "too_large");
            case RpcException.BAD_REQUEST, RpcException.FORBIDDEN, RpcException.CONFLICT ->
                    new ToolFailure(e.code(), word == null ? e.code() : word);
            default -> new ToolFailure(RpcException.INTERNAL, "internal");
        };
    }

    // ---- arguments: each normalized the same way at the look and at the run, so what was approved is what runs

    private static Map<String, Object> searchPayload(Map<String, Object> args) throws ToolFailure {
        if (!(args.get("query") instanceof String query) || query.isBlank()) {
            throw ToolFailure.badArgs("query");
        }
        if (query.length() > QUERY_MAX) {
            throw new ToolFailure(RpcException.TOO_LARGE, "too_large");
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("query", query);
        optionalId(args, "notebookId", payload);
        optionalId(args, "tabId", payload);
        Object limit = args.get("limit");
        if (limit != null) {
            if (!(limit instanceof Number n) || n.doubleValue() != n.longValue() || n.longValue() < 1 || n.longValue() > SEARCH_MAX) {
                throw ToolFailure.badArgs("limit");
            }
            payload.put("limit", n.longValue());
        }
        return payload;
    }

    private static Map<String, Object> readPayload(Map<String, Object> args) throws ToolFailure {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("pageId", pageId(args));
        Object from = args.get("from");
        if (from != null) {
            if (!(from instanceof Number n) || n.doubleValue() != n.longValue() || n.longValue() < 0) {
                throw ToolFailure.badArgs("from");
            }
            payload.put("from", n.longValue());
        }
        return payload;
    }

    /** API.md section 18's {@code {pageId?, new?: {tabId, title}, op, markdown, find?}}, as the card shows it. */
    static Map<String, Object> writePayload(Map<String, Object> args) throws ToolFailure {
        if (!(args.get("op") instanceof String op) || !OPS.contains(op)) {
            throw ToolFailure.badArgs("op");
        }
        if (!(args.get("markdown") instanceof String markdown)) {
            throw ToolFailure.badArgs("markdown");
        }
        if (markdown.length() > MARKDOWN_MAX) {
            throw new ToolFailure(RpcException.TOO_LARGE, "too_large");
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        if ("create".equals(op)) {
            if (args.get("pageId") != null) {
                throw ToolFailure.badArgs("pageId");
            }
            if (!(args.get("new") instanceof Map<?, ?> made) || !(made.get("tabId") instanceof String tabId)
                    || !ID.matcher(tabId).matches()) {
                throw ToolFailure.badArgs("new");
            }
            if (!(made.get("title") instanceof String title) || title.isBlank() || title.length() > TITLE_MAX) {
                throw ToolFailure.badArgs("title");
            }
            Map<String, Object> page = new LinkedHashMap<>();
            page.put("tabId", tabId);
            page.put("title", title);
            payload.put("new", page);
        } else {
            if (args.get("new") != null) {
                throw ToolFailure.badArgs("new");
            }
            payload.put("pageId", pageId(args));
        }
        payload.put("op", op);
        payload.put("markdown", markdown);
        if ("replace_text".equals(op)) {
            if (!(args.get("find") instanceof String find) || find.isEmpty() || find.length() > MARKDOWN_MAX) {
                throw ToolFailure.badArgs("find");
            }
            payload.put("find", find);
        } else if (args.get("find") != null) {
            throw ToolFailure.badArgs("find");
        }
        return payload;
    }

    private static String pageId(Map<String, Object> args) throws ToolFailure {
        if (!(args.get("pageId") instanceof String pageId) || !ID.matcher(pageId).matches()) {
            throw ToolFailure.badArgs("pageId");
        }
        return pageId;
    }

    private static void optionalId(Map<String, Object> args, String key, Map<String, Object> payload) throws ToolFailure {
        Object value = args.get(key);
        if (value == null) {
            return;
        }
        if (!(value instanceof String id) || !ID.matcher(id).matches()) {
            throw ToolFailure.badArgs(key);
        }
        payload.put(key, id);
    }

    /** {@code {kind: "page", pageId, title}}: a new page's pageId is null. */
    private static Map<String, Object> target(String pageId, String title) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", "page");
        m.put("pageId", pageId);
        m.put("title", title);
        return m;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object r) {
        return r instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
    }
}
