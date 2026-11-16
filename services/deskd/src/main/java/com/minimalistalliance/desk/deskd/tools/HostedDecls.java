package com.minimalistalliance.desk.deskd.tools;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * The tools deskd runs for desk-agent, declared in code (draft ADR "the Agent's tools and approvals", sections 1 and 2):
 * deskd's own copy of each one's area, scope, class and taints, so deskd never takes desk-agent's word for any of them.
 * {@link ToolHost} runs nothing that isn't here. desk-agent's registry has the same names with the same classes and
 * taints; {@code HostedDeclsTest} pins both.
 *
 * <p>No setting changes this table. A call's class can rise above its floor here, never fall below it.
 */
public final class HostedDecls {

    public static final String FILES = "files";
    public static final String BROWSER = "browser";
    public static final String NOTEBOOK = "notebook";
    /**
     * Messages between the member's desks (draft ADR §14): no app of its own, but a grant per agent and per desk that
     * the area itself checks in deskd's own record ({@code desks/DeskGrants}).
     */
    public static final String DESKS = "desks";
    /** To-do (API.md §22): {@link TodoTools}. */
    public static final String TODO = "todo";
    /** Courier, read only (the draft ADR's §12; API.md §21, "The agent's Courier tools"): {@link CourierTools}. */
    public static final String COURIER = "courier";
    /**
     * Documents (API.md §25, "Desk Maia's document tools"): {@link DocsTools}, Desk Maia's alone. No app of an agent's
     * covers it: the area itself checks the caller is {@code maia} and that deskd's record has Maia Mode on.
     */
    public static final String DOCS = "docs";

    /**
     * One hosted tool.
     *
     * @param area which {@link HostedTool} runs it
     * @param scope its one narrow scope; {@code browser:member} stands for {@code browser:member:<site>}
     * @param floor its class, the least any call of it is
     * @param taints what every result adds to the run: {@code U}, {@code S}
     * @param browse a browse action, which the Rule of Two makes {@code egress} in a run holding both U and S
     * @param restart what a lost link or a restart does to a call of it that had started: desk-agent's
     *     {@code ToolDecl.restart}, pinned to it. deskd keeps a {@link Restart#RETRY_BY_KEY} call's result by its key
     *     ({@link ToolHost}), and a {@link Restart#SAFE} one's only if the call's class rose to one that asks.
     */
    public record Decl(String name, String area, String scope, ToolRisk floor, Set<String> taints, boolean browse,
            Restart restart) {
        public Decl {
            Objects.requireNonNull(name);
            Objects.requireNonNull(area);
            Objects.requireNonNull(scope);
            Objects.requireNonNull(floor);
            taints = Set.copyOf(taints);
            restart = restart == null ? Restart.RETRY_BY_KEY : restart;
        }

        /** A declaration that names no rule: {@link Restart#RETRY_BY_KEY}, never {@link Restart#SAFE}. */
        public Decl(String name, String area, String scope, ToolRisk floor, Set<String> taints, boolean browse) {
            this(name, area, scope, floor, taints, browse, null);
        }
    }

    /**
     * What a restart does to a call in flight (draft ADR "the Agent's tools and approvals", §3, "Restarts"), as
     * desk-agent's {@code tool/Restart}: deskd hosts only the first and the last.
     */
    public enum Restart {
        /** Asked again by its key after a lost link, it gets the stored result; deskd never runs it twice. */
        RETRY_BY_KEY,
        /** Runs in desk-agent: none here. */
        INTERRUPT,
        /** A read: running it again changes nothing, so its result isn't kept. */
        SAFE
    }

    private static final Set<String> NONE = Set.of();
    private static final Set<String> S = Set.of("S");
    private static final Set<String> U = Set.of("U");
    private static final Set<String> SU = Set.of("S", "U");
    private static final Restart SAFE = Restart.SAFE;
    private static final Restart KEYED = Restart.RETRY_BY_KEY;

    /** Every hosted tool, by name, in the ADR's order. */
    public static final Map<String, Decl> ALL;

    static {
        Map<String, Decl> all = new LinkedHashMap<>();
        // Files: the member's /data/files, never .trash or .uploads; trash only, nothing permanent.
        put(all, new Decl("files_list", FILES, "files:read", ToolRisk.READ, S, false, SAFE));
        put(all, new Decl("files_search", FILES, "files:read", ToolRisk.READ, S, false, SAFE));
        put(all, new Decl("files_read", FILES, "files:read", ToolRisk.READ, SU, false, SAFE));
        put(all, new Decl("files_write", FILES, "files:write", ToolRisk.WRITE, NONE, false, KEYED));
        put(all, new Decl("files_mkdir", FILES, "files:write", ToolRisk.WRITE, NONE, false, KEYED));
        put(all, new Decl("files_move", FILES, "files:write", ToolRisk.WRITE, NONE, false, KEYED));
        put(all, new Decl("files_trash", FILES, "files:trash", ToolRisk.DELETE, NONE, false, KEYED));
        // The Browser: the agent's own off-the-record context, or one granted site of the member's session.
        put(all, new Decl("browser_open", BROWSER, "browser:agent", ToolRisk.READ, U, true, KEYED));
        put(all, new Decl("browser_read", BROWSER, "browser:agent", ToolRisk.READ, U, false, SAFE));
        put(all, new Decl("browser_click", BROWSER, "browser:agent", ToolRisk.READ, U, true, KEYED));
        put(all, new Decl("browser_type", BROWSER, "browser:agent", ToolRisk.READ, NONE, true, KEYED));
        put(all, new Decl("browser_press", BROWSER, "browser:agent", ToolRisk.READ, U, true, KEYED));
        put(all, new Decl("browser_back", BROWSER, "browser:agent", ToolRisk.READ, NONE, true, KEYED));
        put(all, new Decl("browser_close", BROWSER, "browser:agent", ToolRisk.READ, NONE, false, SAFE));
        put(all, new Decl("browser_tabs", BROWSER, "browser:agent", ToolRisk.READ, NONE, false, SAFE));
        put(all, new Decl("browser_use_my_session", BROWSER, "browser:member", ToolRisk.EGRESS, S, false, KEYED));
        // Notebook, as the agent's owner, under their grants on a guild desk.
        put(all, new Decl("notebook_search", NOTEBOOK, "notebook:read", ToolRisk.READ, S, false, SAFE));
        put(all, new Decl("notebook_list", NOTEBOOK, "notebook:read", ToolRisk.READ, S, false, SAFE));
        put(all, new Decl("notebook_read", NOTEBOOK, "notebook:read", ToolRisk.READ, S, false, SAFE));
        put(all, new Decl("notebook_write", NOTEBOOK, "notebook:write", ToolRisk.WRITE, NONE, false, KEYED));
        put(all, new Decl("notebook_trash", NOTEBOOK, "notebook:trash", ToolRisk.DELETE, NONE, false, KEYED));
        // Messages between the member's desks: own from a run holding no S, send from one that does (the area's own
        // class); each makes one sealed envelope, kept by its key, so a call asked again never makes a second.
        put(all, new Decl("desk_message", DESKS, "desks:message", ToolRisk.OWN, U, false, KEYED));
        put(all, new Decl("desk_answer", DESKS, "desks:answer", ToolRisk.OWN, NONE, false, KEYED));
        // To-do, as the agent's owner, on this desk only (API.md §22). Reads add S, and U for an untrusted item (the
        // result's own taint). todo_close's floor is own: a suggestion; only a close rises to write (TodoTools).
        put(all, new Decl("todo_list", TODO, "todo:read", ToolRisk.READ, S, false, SAFE));
        put(all, new Decl("todo_get", TODO, "todo:read", ToolRisk.READ, S, false, SAFE));
        put(all, new Decl("todo_add", TODO, "todo:write", ToolRisk.WRITE, NONE, false, KEYED));
        put(all, new Decl("todo_update", TODO, "todo:write", ToolRisk.WRITE, NONE, false, KEYED));
        put(all, new Decl("todo_close", TODO, "todo:write", ToolRisk.OWN, NONE, false, KEYED));
        // Courier, read only (§12): the member's messages and email, never a Request, never a send. Every result is
        // other people's words and the member's private messages at once, so U and S. courier_new moves the run's place
        // in the new messages, so a lost reply is asked again by its key and gets the same ones, never the next.
        put(all, new Decl("courier_list", COURIER, "courier:read", ToolRisk.READ, SU, false, SAFE));
        put(all, new Decl("courier_search", COURIER, "courier:read", ToolRisk.READ, SU, false, SAFE));
        put(all, new Decl("courier_read", COURIER, "courier:read", ToolRisk.READ, SU, false, SAFE));
        put(all, new Decl("courier_new", COURIER, "courier:read", ToolRisk.READ, SU, false, KEYED));
        // Documents, Desk Maia's only: titles are desk text and private, passages only after the member's tap; nothing
        // here changes a document, a place or a rule. docs_offer_rule only words a question she asks with ask_member.
        put(all, new Decl("docs_find", DOCS, "docs:read", ToolRisk.READ, SU, false, SAFE));
        put(all, new Decl("docs_handover", DOCS, "docs:read", ToolRisk.READ, SU, false, SAFE));
        put(all, new Decl("docs_ask", DOCS, "docs:read", ToolRisk.READ, SU, false, SAFE));
        put(all, new Decl("docs_offer_rule", DOCS, "docs:read", ToolRisk.READ, SU, false, SAFE));
        ALL = Collections.unmodifiableMap(all);
    }

    /** The one tool that isn't one: desk-agent's word that a run ended. */
    public static final String RUN_END = "run_end";

    /**
     * To-do's group (the draft ADR's §15, "Add to-dos, and tick off ones it added"; API.md §22). Which of these one call
     * is in is deskd's per-call decision ({@link TodoTools}'s outcome, the look's {@code group}), not the tool's alone, so
     * {@link ToolHost} takes it from the look rather than from {@link #lowRisk}.
     */
    public static final Map<String, String> TODO_GROUP = Map.of("todo_add", "todos", "todo_update", "todos", "todo_close", "todos");

    /**
     * deskd's own copy of the low-risk map (desk-agent's {@code approval/LowRisk}), tool to group: the writes a member may
     * let one agent make without asking (the draft ADR's §15): {@code notebook_write} (create, append) in the
     * {@code notebook} switch's tab; {@code files_write} (new files) and {@code files_mkdir} in the {@code files} switch's
     * folder (W3); and To-do's ({@link #TODO_GROUP}, W4), whose class is the look's per call. A test in desk-agent pins it
     * to desk-agent's.
     */
    public static final Map<String, String> LOW_RISK = Map.of(
            "notebook_write", "notebook",
            "files_write", "files",
            "files_mkdir", "files",
            "todo_add", "todos",
            "todo_update", "todos",
            "todo_close", "todos");

    /** §15's unasked sizes. */
    static final int FILE_TEXT_MAX = 64 * 1024;
    static final int MARKDOWN_MAX = 8_000;

    /**
     * Whether a call is in the low-risk class, by deskd's own declarations, class, context, taint and the arguments it
     * received: on {@code groups}; its floor and its class exactly {@code write} (never a delete, a send, a spend or an
     * egress, and never a read risen to a write); in the agent's own context; in a run with no untrusted content; and only
     * adding, by a rule of its own tool, within the unasked sizes (a {@code files_write} that doesn't replace, 64 Ki
     * characters at most; a {@code files_mkdir}; a {@code notebook_write} that creates, 8,000 characters with its title, or
     * appends, 8,000). A tool with no rule here is never in it, whatever the map says (Security's AAW-L4): no map can
     * widen the rest. The switch's place is the area's ({@link HostedTool#checksAuto}).
     */
    public static boolean lowRisk(Map<String, String> groups, Decl decl, ToolRisk risk, String context,
            boolean untrusted, Map<String, Object> args) {
        if (decl == null || !groups.containsKey(decl.name()) || decl.floor() != ToolRisk.WRITE || risk != ToolRisk.WRITE
                || !"agent".equals(context) || untrusted) {
            return false;
        }
        Map<String, Object> a = args == null ? Map.of() : args;
        return switch (decl.name()) {
            case "files_write" -> !Boolean.TRUE.equals(a.get("replace")) && a.get("path") instanceof String
                    && a.get("text") instanceof String text && text.length() <= FILE_TEXT_MAX;
            case "files_mkdir" -> a.get("path") instanceof String;
            case "notebook_write" -> switch (String.valueOf(a.get("op"))) {
                case "create" -> a.get("new") instanceof Map<?, ?> made && made.get("tabId") instanceof String
                        && made.get("title") instanceof String title && a.get("markdown") instanceof String md
                        && md.length() + title.length() <= MARKDOWN_MAX;
                case "append" -> a.get("pageId") instanceof String && a.get("markdown") instanceof String md
                        && md.length() <= MARKDOWN_MAX;
                default -> false;
            };
            default -> false;
        };
    }

    private HostedDecls() {}

    private static void put(Map<String, Decl> all, Decl decl) {
        if (all.put(decl.name(), decl) != null) {
            throw new IllegalStateException("declared twice: " + decl.name());
        }
    }

    /** @return the declaration, or null for a tool deskd doesn't host */
    public static Decl get(String name) {
        return name == null ? null : ALL.get(name);
    }
}
