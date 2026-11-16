package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.notebook.NotebookCalls;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

/**
 * The Notebook area of the Agent's tools (draft ADR "the Agent's tools and approvals", sections 2, 8, 15 and 17; API.md
 * section 18): {@code notebook_search}, {@code notebook_list}, {@code notebook_read}, {@code notebook_write} and
 * {@code notebook_trash}, on the desk's Notebook through desk-notebook, as {@code call.caller()}: deskd's own stamp, the
 * desk's owner, or on a guild desk the member whose agent it is, never anything desk-agent sent. desk-notebook checks
 * every call as it checks that member's own session ({@link NotebookCalls}): their grants, the edit budget, the rules for
 * a page in the Trash, page_full.
 *
 * <p>Pages read and write as desk-notebook's exact Markdown (its {@code pageMarkdown.ts} and {@code markdown.ts}): what
 * an agent reads it can write back with nothing lost, colors included. What the Notebook has no node for (a table, an
 * image) is converted, and both the card's look and the result say so. A write runs under the approval's id as its key,
 * so desk-notebook does it once whatever happens to its answer, and {@link #undo} finds it by that id.
 *
 * <p>A write's look asks desk-notebook for a dry run of exactly the payload, so the card has the page's title and an
 * edit that would be refused anyway (a {@code find} that isn't there or is there twice, past the edit budget, a page in
 * the Trash) is refused before anyone is asked. The look before a run asks nothing: the run is checked again where it
 * happens. An edit is "Edited by" the agent by its id, which the desk app shows as the agent's name; deskd keeps none.
 * Trash only: restoring stays the member's.
 *
 * <p>On a guild desk every result adds U, as guild content came from other members. On the member's own desk a page
 * reads back as theirs ({@code S}), except text an agent wrote from a run holding U (Security's ATN-M1): every write
 * carries this run's {@code untrusted} from deskd's own copy of its taint, desk-notebook marks what it writes then, and
 * a read, a tab's list or a search hit of a page that still holds marked text adds U here, as a marked workspace file
 * does in desk-agent. So one approved write from a run that read a web page can't make that page's text trusted for the
 * next run, which could then browse with no card. A search whose marks can't be checked counts as untrusted. Nothing
 * here logs or puts in a {@link ToolFailure} any page text, title, query or Markdown: desk-notebook's refusal words only.
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
    /** What desk-notebook may say it converted, each with what the model reads of it. */
    private static final Map<String, String> CONVERTED = Map.of(
            "table", "The Notebook has no tables: each row became a line of text, its cells apart.",
            "image", "The Notebook has no images yet: each image became a link to it.",
            "html", "HTML the Notebook doesn't know stays as text.",
            "heading_level", "Headings past ### became ###, the Notebook's smallest.");
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

    /**
     * {@code notebook_write} done without asking (create, append) is held to the Notebook switch's tab: a new page's
     * {@code new.tabId} here, and desk-notebook checks the tab of the page an append goes to as it writes, inside the
     * page's queue ({@code tab}), so a page moved out since is outside (draft ADR §15).
     */
    @Override
    public boolean checksAuto(String tool) {
        return "notebook_write".equals(tool);
    }

    /** The prefix of an unasked edit's key: a space no member's approval id can be in (Security's AAW-L2). */
    static final String AUTO_KEY = "auto:";

    @Override
    public Look look(HostedCall call, RunLedger.Run run) throws ToolFailure, InterruptedException {
        return switch (call.tool()) {
            case "notebook_search" -> Look.plain(searchPayload(call.args()), null);
            case "notebook_list" -> Look.plain(listPayload(call.args()), null);
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
        // The card can say what won't come out as written, as the result will.
        List<String> converted = converted(r);
        if (!converted.isEmpty()) {
            target.put("converted", converted);
        }
        Map<String, Object> before = null;
        if (pageId != null) {
            String title = r.get("title") instanceof String t ? t : "";
            target.put("title", title);
            // The page's tab now, so desk-agent's gate can tell whether an append is in a switch's tab (it's checked again
            // where it's written).
            if (r.get("tabId") instanceof String tab && ID.matcher(tab).matches()) {
                target.put("tabId", tab);
            }
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
        boolean guild = guildDesk.getAsBoolean();
        Set<String> taints = new HashSet<>(guild ? Set.of("U") : Set.of());
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
                if (!guild && markedAmong(call, hits)) {
                    taints.add("U");
                }
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("hits", hits);
                yield new Result(out, taints, Map.of());
            }
            case "notebook_list" -> {
                Map<String, Object> r = object(ask(call, "notebook.outline", listPayload(call.args()), false));
                Map<String, Object> out = new LinkedHashMap<>();
                if (r.containsKey("notebooks")) {
                    out.put("notebooks", r.get("notebooks"));
                    if (Boolean.TRUE.equals(r.get("more"))) {
                        out.put("note", "There are more tabs than shown.");
                    }
                } else {
                    for (String key : List.of("tabId", "title", "notebookId", "pages", "from", "next")) {
                        out.put(key, r.get(key));
                    }
                    if (r.get("next") != null) {
                        out.put("note", "There are more pages in this tab: list it again with from set to next.");
                    }
                    if (Boolean.TRUE.equals(r.get("untrusted"))) {
                        taints.add("U");
                    }
                }
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
                if (Boolean.TRUE.equals(r.get("untrusted"))) {
                    taints.add("U");
                }
                yield new Result(out, taints, Map.of());
            }
            case "notebook_write" -> {
                Map<String, Object> params = new LinkedHashMap<>(writePayload(call.args()));
                params.put("agentName", call.agentId());
                // deskd's own copy of the run's taint, so what a run that read untrusted content writes is marked.
                params.put("untrusted", run != null && run.untrusted());
                // The approval's id is the edit's key: done once, whatever happens to the answer, and undone by it. A call
                // done without asking under the member's switch (the draft ADR's §15) carries its own approval id from
                // desk-agent's gate (autoApprovalId), keyed auto:<id>, a space a member's approval can't use (AAW-L2),
                // and held to the switch's tab where desk-notebook writes it.
                String key;
                HostedCall.AutoPlace place = call.autoPlace();
                if (place != null) {
                    Object op = params.get("op");
                    String tab = place.tabId();
                    if (tab == null || !("create".equals(op) || "append".equals(op))
                            || ("create".equals(op) && !(params.get("new") instanceof Map<?, ?> made
                                    && tab.equals(made.get("tabId"))))) {
                        throw ToolFailure.refused("place");
                    }
                    if ("append".equals(op)) {
                        // deskd's own look at the page's tab first, so the check never rests on desk-notebook alone (an
                        // older one ignores tab, and says no tabId: refused); desk-notebook checks it again in the page's
                        // queue as it writes, so a page moved out between the two is outside too.
                        Map<String, Object> dry = new LinkedHashMap<>(params);
                        dry.put("agentName", call.agentId());
                        dry.put("dryRun", true);
                        dry.remove("untrusted");
                        Map<String, Object> seen = object(ask(call, "notebook.page.agentEdit", dry, false));
                        if (!tab.equals(seen.get("tabId"))) {
                            throw ToolFailure.refused("place");
                        }
                    }
                    params.put("tab", tab);
                    key = call.autoApprovalId() == null ? null : AUTO_KEY + call.autoApprovalId();
                    if (key == null) {
                        throw ToolFailure.badArgs("autoApprovalId");
                    }
                } else {
                    key = call.approval() != null ? call.approval().approvalId() : null;
                }
                if (key != null && ID.matcher(key).matches()) {
                    params.put("key", key);
                }
                Map<String, Object> r = object(ask(call, "notebook.page.agentEdit", params, true));
                if (place != null && Boolean.TRUE.equals(r.get("repeated"))) {
                    // An unasked edit's key seen before is a reused id, never a retry that may say saved.
                    throw ToolFailure.forbidden("approval_used");
                }
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("pageId", r.get("pageId"));
                out.put("title", r.get("title"));
                out.put("op", r.get("op"));
                out.put("saved", true);
                List<String> notes = new ArrayList<>();
                if (r.get("versionId") != null) {
                    out.put("versionId", r.get("versionId"));
                    notes.add("The page as it was before is a version in its history, so the member can go back to it.");
                }
                List<String> converted = converted(r);
                if (!converted.isEmpty()) {
                    out.put("converted", converted);
                    for (String c : converted) {
                        notes.add(CONVERTED.get(c));
                    }
                }
                if (!notes.isEmpty()) {
                    out.put("note", String.join(" ", notes));
                }
                // The title is the page's first line, which marked text may be.
                if (Boolean.TRUE.equals(r.get("untrusted"))) {
                    taints.add("U");
                }
                Map<String, Object> made = null;
                if (place != null) {
                    made = new LinkedHashMap<>();
                    made.put("kind", "notebook");
                    made.put("key", key);
                    made.put("pageId", r.get("pageId") instanceof String id && ID.matcher(id).matches() ? id : null);
                    made.put("op", params.get("op"));
                }
                yield new Result(out, taints, Map.of(), made);
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

    /**
     * The undo of an agent's edit, by the approval it ran under: draft ADR section 15's {@code agent.approval.undo}, for
     * the auto-approve builder's undo to call, as the agent's owner. desk-notebook takes out exactly what the edit put
     * there, and only while it's as the agent left it; a new page goes to the Trash.
     *
     * @return {@code {pageId, op, undone: true}}
     * @throws ToolFailure {@code conflict} {@code changed} with the {@code pre_agent} {@code versionId} to offer instead,
     *     {@code undone}, {@code trashed}; {@code not_found} for no such edit; {@code forbidden} {@code grant} on a guild
     *     desk for another member's agent's edit
     */
    public Map<String, Object> undo(Caller caller, String approvalId)
            throws ToolFailure, InterruptedException {
        return undo(caller, approvalId, null);
    }

    /**
     * The undo of the agent's own edit by its key, checking the edit is that agent's ({@code agent}, desk-notebook's
     * {@code agent_edits.agent}, which deskd stamped from the agent's id). For deskd's undo of an unasked edit
     * ({@link #undoAuto}).
     */
    Map<String, Object> undo(Caller caller, String key, String agentId) throws ToolFailure, InterruptedException {
        if (key == null || !ID.matcher(key).matches()) {
            throw ToolFailure.badArgs("approvalId");
        }
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("key", key);
        if (agentId != null) {
            params.put("agent", agentId);
        }
        Map<String, Object> r;
        try {
            r = object(notebook.call(caller, "notebook.page.agentUndo", params, true));
        } catch (RpcException e) {
            throw failure(e);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("pageId", r.get("pageId"));
        out.put("op", r.get("op"));
        out.put("undone", Boolean.TRUE.equals(r.get("undone")));
        return out;
    }

    /** The undo of an edit made without asking, by deskd's own record of its key and agent (draft ADR §15). */
    @Override
    public Map<String, Object> undoAuto(Caller caller, AutoLedger.Entry entry) throws ToolFailure, InterruptedException {
        Map<String, Object> made = entry.made();
        if (made == null || !(made.get("key") instanceof String key) || !key.startsWith(AUTO_KEY)) {
            throw ToolFailure.notFound("approval");
        }
        return undo(caller, key, entry.agentId());
    }

    /**
     * Whether any of a search's hits is a page holding text an agent wrote from a run holding U. Fails closed: when
     * desk-notebook can't say (an older one, an error), the hits count as untrusted.
     */
    private boolean markedAmong(HostedCall call, List<Object> hits) throws InterruptedException {
        List<String> ids = new ArrayList<>();
        for (Object o : hits) {
            if (o instanceof Map<?, ?> hit && hit.get("pageId") instanceof String id && !ids.contains(id)) {
                ids.add(id);
            }
        }
        if (ids.isEmpty()) {
            return false;
        }
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("pageIds", ids);
        try {
            Object r = ask(call, "notebook.page.marked", params, false);
            return !(r instanceof Map<?, ?> m && m.get("marked") instanceof List<?> marked && marked.isEmpty());
        } catch (ToolFailure e) {
            return true;
        }
    }

    private Object ask(HostedCall call, String method, Map<String, Object> params, boolean mutation)
            throws ToolFailure, InterruptedException {
        try {
            return notebook.call(call.caller(), method, params, mutation);
        } catch (RpcException e) {
            throw failure(e);
        }
    }

    /** What desk-notebook says it converted, its words only. */
    private static List<String> converted(Map<String, Object> r) {
        List<String> out = new ArrayList<>();
        if (r.get("converted") instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof String c && CONVERTED.containsKey(c) && !out.contains(c)) {
                    out.add(c);
                }
            }
        }
        return out;
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
            // A change the member made since: the version from before is what to offer, its id only.
            case RpcException.CONFLICT -> "changed".equals(word) && details.get("versionId") instanceof String v
                    && ID.matcher(v).matches()
                    ? new ToolFailure(e.code(), word, Map.of("versionId", v))
                    : new ToolFailure(e.code(), word == null ? e.code() : word);
            case RpcException.BAD_REQUEST, RpcException.FORBIDDEN ->
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

    /** {@code {tabId?, from?}}: without a tab, the notebooks and their tabs; with one, its pages, 100 at a time. */
    private static Map<String, Object> listPayload(Map<String, Object> args) throws ToolFailure {
        Map<String, Object> payload = new LinkedHashMap<>();
        optionalId(args, "tabId", payload);
        Object from = args.get("from");
        if (from != null) {
            if (!payload.containsKey("tabId") || !(from instanceof Number n) || n.doubleValue() != n.longValue() || n.longValue() < 0) {
                throw ToolFailure.badArgs("from");
            }
            payload.put("from", n.longValue());
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
