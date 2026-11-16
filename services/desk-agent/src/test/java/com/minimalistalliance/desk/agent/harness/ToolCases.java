package com.minimalistalliance.desk.agent.harness;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * <b>The registration</b>: one line per tool an agent can call (W7's shared harness, Maia Mode Phase 0). Every tool in
 * {@code ToolRegistry} must be here, or {@code HarnessCoverageTest} fails and names it. A line says what the harness
 * needs to drive the tool without a real deskd or a real model:
 * <ul>
 *   <li>{@code kind}: how the fault matrix treats it (a read, the agent's own thing, a write the member approves, a
 *       delete, a send), which is the class it's declared at or rises to;
 *   <li>{@code lookRisk}: the class deskd's look gives a typical call (a form's submit is {@code send}), or null for its
 *       declaration's;
 *   <li>{@code args}: a typical call's arguments with the canary in every string the member or the model wrote (the
 *       audit canary plants it there and looks for it in the log); null builds them from the tool's schema;
 *   <li>{@code result}: what deskd's run answers for it, with the canary in it too; null for in-process tools.
 * </ul>
 * Adding a tool (auto-approve, To-do, Courier read, desk messages): one {@code add} line below. If the tool runs in
 * deskd, the counting deskd then runs it; if its kind is new, add it to {@link Kind}.
 */
public final class ToolCases {

    /** How the fault matrix and the threats treat a tool. */
    public enum Kind {
        /** Looks, changes nothing: no card. */
        READ,
        /** The agent's own things: no card; a memory save under U asks. */
        OWN,
        /** Changes the member's things: a card, or done without asking under the member's switch. */
        WRITE,
        /** To a trash: always a card. */
        DELETE,
        /** Delivers something to someone else: always a card. */
        SEND,
        /** The member's data may reach a site, or the member's session: always a card. */
        EGRESS
    }

    /** One tool's line. */
    public record Case(String tool, Kind kind, boolean hosted, String lookRisk,
            Function<String, Map<String, Object>> args, Function<String, Object> result) {}

    private static final Map<String, Case> CASES = new LinkedHashMap<>();

    /**
     * Hosted tools the per-tool kill matrix ({@code FaultMatrixTest.everyHostedTool}) leaves out, and why. Messages
     * between desks need two paired desks; they go through the same keyed seam as every hosted tool, which the generic
     * matrix covers, and main's {@code DeskMessagesFlowTest} kills and restarts each end of a message. Documents' index
     * tools are Desk Maia's alone, and the matrix drives a team agent, whose call of one is refused before deskd runs it
     * ({@code MaiaDocsToolsTest}); each is a read that's safe to ask again, the seam the matrix covers with Courier's.
     */
    private static final String MAIA_ONLY = "Desk Maia's only: a team agent's call is refused before deskd runs it"
            + " (MaiaDocsToolsTest); a read, safe to ask again, on the seam courier_* covers here";

    static final Map<String, String> NOT_IN_MATRIX = Map.of(
            "desk_message", "needs two paired desks (DeskMessagesFlowTest kills and restarts each end)",
            "desk_answer", "needs two paired desks (DeskMessagesFlowTest kills and restarts each end)",
            "docs_find", MAIA_ONLY, "docs_handover", MAIA_ONLY, "docs_ask", MAIA_ONLY, "docs_offer_rule", MAIA_ONLY);

    private ToolCases() {}

    private static void add(String tool, Kind kind, boolean hosted, String lookRisk,
            Function<String, Map<String, Object>> args, Function<String, Object> result) {
        CASES.put(tool, new Case(tool, kind, hosted, lookRisk, args, result));
    }

    private static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    static {
        // ---- the agent's own (desk-agent, in process)
        add("workspace_list", Kind.OWN, false, null, c -> m(), null);
        add("workspace_read", Kind.OWN, false, null, c -> m("path", "notes-" + c + ".md"), null);
        add("workspace_write", Kind.OWN, false, null, c -> m("path", "notes-" + c + ".md", "text", "keep " + c), null);
        add("workspace_delete", Kind.OWN, false, null, c -> m("path", "old-" + c + ".md"), null);
        add("message_agent", Kind.OWN, false, null, null, null);
        add("desk_agents", Kind.READ, false, null, null, null);
        add("desk_choices", Kind.READ, false, null, null, null);
        for (String propose : List.of("propose_agent", "propose_agent_change", "propose_agent_removal",
                "propose_links", "propose_timer", "propose_timer_removal")) {
            add(propose, Kind.OWN, false, null, null, null);
        }
        add("plan_update", Kind.OWN, false, null, c -> m("steps", List.of(m("text", "step " + c, "state", "doing"))),
                null);
        add("follow_up", Kind.WRITE, false, null, c -> m("inMinutes", 30, "prompt", "check " + c), null);
        add("memory_save", Kind.OWN, false, null, null, null);
        add("memory_forget", Kind.OWN, false, null, null, null);
        // ---- Files (deskd)
        add("files_list", Kind.READ, true, null, c -> m("path", "Harness"),
                c -> m("path", "Harness", "entries", List.of(m("name", c + ".md", "kind", "file", "size", 3))));
        add("files_search", Kind.READ, true, null, c -> m("q", c),
                c -> m("hits", List.of(m("path", "Harness/" + c + ".md", "kind", "file"))));
        add("files_read", Kind.READ, true, null, c -> m("path", "Harness/in-" + c + ".md"),
                c -> m("path", "Harness/in.md", "text", "inside " + c, "offset", 0, "next", null));
        add("files_write", Kind.WRITE, true, null, c -> m("path", "Harness/out-" + c + ".md", "text", "text " + c),
                c -> m("path", "Harness/out.md", "bytes", 9));
        add("files_mkdir", Kind.WRITE, true, null, c -> m("path", "Harness/dir-" + c), c -> m("path", "Harness/dir"));
        add("files_move", Kind.WRITE, true, null, c -> m("from", "Harness/a-" + c + ".md", "to", "Harness/b-" + c
                + ".md"), c -> m("from", "a", "to", "b"));
        add("files_trash", Kind.DELETE, true, null, c -> m("path", "Harness/old-" + c + ".md"),
                c -> m("trashed", "old.md"));
        // ---- the Browser (deskd): the agent's own context
        add("browser_open", Kind.READ, true, null, c -> m("url", "https://example.com/" + c),
                c -> m("tabId", "t1", "title", "Example " + c, "text", "page " + c));
        add("browser_read", Kind.READ, true, null, c -> m("tabId", "t1"),
                c -> m("tabId", "t1", "text", "page " + c, "from", 0, "next", null));
        add("browser_click", Kind.SEND, true, "send", c -> m("tabId", "t1", "ref", "n-" + c),
                c -> m("tabId", "t1", "text", "sent " + c));
        add("browser_type", Kind.READ, true, null, c -> m("tabId", "t1", "ref", "n2", "text", "typed " + c),
                c -> m("tabId", "t1"));
        add("browser_press", Kind.READ, true, null, c -> m("tabId", "t1", "ref", "n3", "key", "Escape"),
                c -> m("tabId", "t1", "text", "page " + c));
        add("browser_back", Kind.READ, true, null, c -> m("tabId", "t1"), c -> m("tabId", "t1"));
        add("browser_close", Kind.READ, true, null, c -> m("tabId", "t1"), c -> m("closed", true));
        add("browser_tabs", Kind.READ, true, null, c -> m(), c -> m("tabs", List.of(m("tabId", "t1", "title", c))));
        // The site is the one argument §7 lets the log keep (browser.session.grant's origin), so it carries a marker of
        // its own rather than the canary; AuditCanaryTest checks that row by name.
        add("browser_use_my_session", Kind.EGRESS, true, null, c -> m("site", "granted-site.example"),
                c -> m("tabId", "t9", "site", "granted-site.example", "text", "page " + c));
        // ---- Notebook (deskd)
        add("notebook_search", Kind.READ, true, null, c -> m("query", c),
                c -> m("hits", List.of(m("pageId", "p-1", "title", "Plan", "snippet", c))));
        add("notebook_list", Kind.READ, true, null, c -> m(),
                c -> m("notebooks", List.of(m("notebookId", "n-1", "tabs", List.of(m("tabId", "tab-1", "title",
                        "Harness " + c))))));
        add("notebook_read", Kind.READ, true, null, c -> m("pageId", "p-1"),
                c -> m("pageId", "p-1", "title", "Plan", "markdown", "# Plan\n" + c + "\n", "from", 0, "next", null));
        add("notebook_write", Kind.WRITE, true, null, c -> m("new", m("tabId", "tab-1", "title", "Note " + c), "op",
                "create", "markdown", "text " + c), c -> m("pageId", "p-2", "title", "Note", "versionId", "v-1"));
        add("notebook_trash", Kind.DELETE, true, null, c -> m("pageId", "p-1"), c -> m("pageId", "p-1"));
        // ---- To-do (deskd; W4, sub/mm-todo-store)
        add("todo_list", Kind.READ, true, null, null,
                c -> m("items", List.of(m("id", "td-1", "title", "Pay " + c, "state", "open"))));
        add("todo_get", Kind.READ, true, null, c -> m("id", "td-1"),
                c -> m("id", "td-1", "title", "Pay " + c, "note", "note " + c, "state", "open"));
        add("todo_add", Kind.WRITE, true, null, c -> m("title", "Pay " + c, "note", "note " + c, "source",
                m("kind", "agent_chat", "ref", m())), c -> m("id", "td-2", "title", "Pay", "state", "open"));
        add("todo_update", Kind.WRITE, true, null, c -> m("id", "td-1", "rev", 1, "title", "Pay " + c),
                c -> m("id", "td-1", "rev", 2));
        // ---- Courier, read only (deskd; W5)
        add("courier_list", Kind.READ, true, null, null,
                c -> m("channels", List.of(m("channelId", "ch-1", "title", "From " + c, "unread", 1))));
        add("courier_search", Kind.READ, true, null, c -> m("q", "dinner " + c),
                c -> m("hits", List.of(m("messageId", "m-1", "channelId", "ch-1", "snippet", "about " + c))));
        add("courier_read", Kind.READ, true, null, null,
                c -> m("messageId", "m-1", "from", m("name", "A sender"), "text", "body " + c));
        add("courier_new", Kind.READ, true, null, c -> m(),
                c -> m("messages", List.of(m("messageId", "m-2", "text", "new " + c))));
        // ---- Messages between the member's desks (deskd; W6): own from a run without S, a send from one with it; the
        // harness tests the stricter path, as deskd's look gives it in a run holding S.
        add("desk_message", Kind.SEND, true, "send", null, c -> m("envelopeId", "env-1", "state", "sent"));
        add("desk_answer", Kind.SEND, true, "send", null, c -> m("envelopeId", "env-2", "state", "sent"));
        // ---- Documents' index (deskd, API.md §25): Desk Maia's only, read only; titles and passages are U and S.
        add("docs_find", Kind.READ, true, null, c -> m("person", "Sam " + c, "words", "contract " + c),
                c -> m("items", List.of(m("deskId", "d-home1", "docId", "d_01JC0000000000000000000000", "title",
                        "Contract " + c, "kind", "attachment", "place", "needs"))));
        add("docs_handover", Kind.READ, true, null, c -> m("docId", "d_01JC0000000000000000000000"),
                c -> m("docId", "d_01JC0000000000000000000000", "title", "Contract " + c, "place", "needs"));
        add("docs_ask", Kind.READ, true, null, c -> m("docId", "d_01JC0000000000000000000000", "question",
                "When is it due " + c), c -> m("passages", List.of(m("page", 2, "text", "due " + c))));
        add("docs_offer_rule", Kind.READ, true, null, c -> m("docId", "d_01JC0000000000000000000000"),
                c -> m("question", "Where do invoices like " + c + " go?"));
        // ---- Desk Maia's own (desk-agent, in process; Maia Mode Phase 1, c0a9b8e4)
        add("office_desks", Kind.READ, false, null, null, null);
        add("office_desk_status", Kind.READ, false, null, null, null);
        add("office_show", Kind.OWN, false, null, null, null);
        add("ask_member", Kind.OWN, false, null, null, null);
        // Maia Mode Phase 2 (draft-desk-maia.md decision 12): her check-in, and her reader (a read, untrusted).
        add("maia_check_in", Kind.OWN, false, null, null, null);
        add("maia_read", Kind.READ, false, null, null, null);
        add("working_on", Kind.OWN, false, null, null, null);
        add("paper_note", Kind.OWN, false, null, null, null);
        // Its floor is own (a suggestion); deskd's look makes a close of an item the agent may close a write.
        add("todo_close", Kind.WRITE, true, "write", c -> m("id", "td-1", "as", "done", "reason", "paid " + c),
                c -> m("id", "td-1", "state", "done"));
    }

    /** Every line, in order. */
    public static Map<String, Case> all() {
        return Collections.unmodifiableMap(CASES);
    }

    public static Case of(String tool) {
        return CASES.get(tool);
    }

    /** The tools of one kind. */
    public static List<Case> ofKind(Kind kind) {
        List<Case> out = new ArrayList<>();
        for (Case c : CASES.values()) {
            if (c.kind() == kind) {
                out.add(c);
            }
        }
        return out;
    }

    /**
     * A typical call's arguments: the line's own, or ones made from the tool's input schema with the canary in every
     * string (an enum's first value, 1 for a number, false for a boolean, one item for a list).
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> args(String tool, Map<String, Object> schema, String canary) {
        Case c = CASES.get(tool);
        if (c != null && c.args() != null) {
            return c.args().apply(canary);
        }
        Object made = fromSchema(schema, canary, "x");
        return made instanceof Map<?, ?> map ? (Map<String, Object>) map : new LinkedHashMap<>();
    }

    @SuppressWarnings("unchecked")
    static Object fromSchema(Object node, String canary, String name) {
        if (!(node instanceof Map<?, ?> schema)) {
            return canary + "-" + name;
        }
        if (schema.get("enum") instanceof List<?> values && !values.isEmpty()) {
            return values.get(0);
        }
        Object type = schema.get("type");
        if ("object".equals(type) || schema.get("properties") instanceof Map<?, ?>) {
            Map<String, Object> out = new LinkedHashMap<>();
            if (schema.get("properties") instanceof Map<?, ?> props) {
                for (Map.Entry<?, ?> e : ((Map<String, Object>) props).entrySet()) {
                    out.put((String) e.getKey(), fromSchema(e.getValue(), canary, (String) e.getKey()));
                }
            }
            return out;
        }
        if ("array".equals(type)) {
            return List.of(fromSchema(schema.get("items"), canary, name));
        }
        if ("integer".equals(type) || "number".equals(type)) {
            return 1;
        }
        if ("boolean".equals(type)) {
            return false;
        }
        return canary + "-" + name;
    }
}
