package com.minimalistalliance.desk.agent.approval;

import com.minimalistalliance.desk.agent.tool.Classified;
import com.minimalistalliance.desk.agent.tool.Risk;
import com.minimalistalliance.desk.agent.tool.RunContext;
import com.minimalistalliance.desk.agent.tool.ToolDecl;
import com.minimalistalliance.desk.agent.tool.ToolRegistry;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The low-risk class: the writes a member may let one agent make without asking, by switching on a group for it at
 * setup, in its settings or with a card's "Don't ask again" (the owner's decision of Nov 12: auto-approve for low-risk
 * writes, chosen per agent; ask by default; the draft ADR's §15, built as its W3). {@link #ADR} maps the ADR's tools to
 * their groups:
 * <ul>
 *   <li>{@code notebook}: {@code notebook_write} that creates a page or appends to one, in the switch's tab;
 *   <li>{@code files}: {@code files_write} that doesn't replace, and {@code files_mkdir}, inside the switch's folder;
 *   <li>{@code todos}: declared, with no tool here. Its tools are the To-do builder's (W4, deskd API.md §22), which adds
 *       them to {@link #ADR_GROUPS} with a rule of their own in {@link #onlyAdds} and, for adding a to-do after
 *       {@code U}, in {@link #afterUntrusted} (§15's one exception, Security's ATA-L1). deskd's
 *       {@code HostedDecls.LOW_RISK} is pinned to this map by a test.
 * </ul>
 *
 * <p><b>What no map can widen.</b> A call is in the class only if every one of these holds, checked here and again by
 * deskd ({@code HostedDecls.lowRisk} and {@code ToolHost.requireAuto}):
 * <ul>
 *   <li>its tool runs in deskd, which checks it again (Security's AAW-I5): never one desk-agent runs alone;
 *   <li>its class is exactly {@code write}, and so is its declaration's: nothing rose, and never a {@code delete},
 *       {@code send}, {@code spend} or {@code egress};
 *   <li>it runs in the agent's own context, never {@code member:<site>};
 *   <li>its run hasn't read untrusted content ({@code U}): §15's one exception, adding a to-do (with a source of
 *       untrusted content the run read, Security's ATA-L1), is deskd's per-call decision, the look's group, as is the
 *       rest of To-do's class ({@code todo_close}'s floor is {@code own}, a suggestion, and only a close rises to
 *       {@code write});
 *   <li>it only adds, by a rule of its own tool ({@link #onlyAdds}; a tool with none never does, Security's AAW-L4):
 *       never a replace, a move, a trash or a rename; and within the unasked sizes, 64 Ki characters of file text,
 *       8,000 of Markdown with a new page's title (AAW-I6);
 *   <li>it isn't {@code follow_up} (a timer starts future spending) or the memory runner's save;
 *   <li>it isn't a guild member's own agent, nor on a Guild Desk at all (§15 rule 8, Security's AAW-L3);
 *   <li>the policy didn't refuse it.
 * </ul>
 * The switch's place ({@link #inPlace}) is the policy's, with the member's switches; the counts are the gate's.
 */
public final class LowRisk {

    /**
     * The tools the draft ADR's §15 puts in a group: Notebook's and Files' (W3), To-do's (W4). deskd's
     * {@code HostedDecls.LOW_RISK} is pinned to this.
     */
    static final Map<String, String> ADR_GROUPS = Map.of(
            "notebook_write", "notebook",
            "files_write", "files",
            "files_mkdir", "files",
            "todo_add", "todos",
            "todo_update", "todos",
            "todo_close", "todos");

    /** The groups, whether or not a tool here is in them yet. */
    public static final Set<String> GROUPS = Set.of("notebook", "files", "todos");

    /** The class as the ADR has it. */
    public static final LowRisk ADR = new LowRisk(ADR_GROUPS);

    /** §15's unasked sizes. */
    static final int FILE_TEXT_MAX = 64 * 1024;
    static final int MARKDOWN_MAX = 8_000;
    /** A Files path's parts, as the folder of a switch can hold. */
    static final int MAX_PATH = 4096;

    private final Map<String, String> groups;
    /** Tests only: a tool with no rule here counts as adding, placeless and run anywhere, to test the gate alone. */
    private final boolean lenient;

    /** A class mapping these tools to their groups, within every rule above. */
    public LowRisk(Map<String, String> groups) {
        this(groups, false);
    }

    private LowRisk(Map<String, String> groups, boolean lenient) {
        this.groups = Map.copyOf(groups);
        this.lenient = lenient;
    }

    /**
     * For tests of the gate alone, never a desk: a class where a tool this class has no rule for (a desk-agent tool such
     * as {@code workspace_write}) counts as adding, needs no place and needn't run in deskd. Every other rule holds.
     */
    public static LowRisk forTest(Map<String, String> groups) {
        return new LowRisk(groups, true);
    }

    /** The call's group, if it's in the class: on the map, and within every rule above; else null. */
    public String groupOf(Classified call, RunContext run) {
        if (call == null || run == null || call.refusal() != null) {
            return null;
        }
        if (call.risk() != Risk.WRITE) {
            return null;
        }
        String tool = call.decl().name();
        if (ToolRegistry.TODO.contains(tool)) {
            // To-do's class is decided per call by deskd, from its own facts (the item's maker and run, its copy of the
            // run's taint, who started the run; Security's ATA-L1 for an add after U): the look's group. Never on a
            // guild desk, never outside the agent's own context; deskd checks it all again as it runs.
            return "agent".equals(call.context()) && !run.owner().isMember() && groups.containsKey(tool)
                    && groups.get(tool).equals(call.group()) ? call.group() : null;
        }
        if (call.decl().risk() != Risk.WRITE) {
            return null;
        }
        if (!lenient && call.decl().host() != ToolDecl.Host.DESKD) {
            return null;
        }
        if (!"agent".equals(call.context()) || run.owner().isMember()) {
            return null;
        }
        if (run.untrusted() && !afterUntrusted(tool)) {
            return null;
        }
        if (call.decl().isMemory() || "follow_up".equals(tool) || !adds(tool, call.payload())) {
            return null;
        }
        return groups.get(tool);
    }

    /** Whether a call is in the class. */
    public boolean covers(Classified call, RunContext run) {
        return groupOf(call, run) != null;
    }

    private boolean adds(String tool, Map<String, Object> payload) {
        Boolean rule = onlyAdds(tool, payload);
        return rule == null ? lenient : rule;
    }

    /**
     * §15's "it only adds", and its sizes, from the exact payload the call will run with; null for a tool with no rule
     * here, which never does (Security's AAW-L4: a map naming {@code files_move} lets no move through).
     */
    static Boolean onlyAdds(String tool, Map<String, Object> payload) {
        return switch (tool) {
            case "files_write" -> !Boolean.TRUE.equals(payload.get("replace"))
                    && payload.get("path") instanceof String
                    && payload.get("text") instanceof String text && text.length() <= FILE_TEXT_MAX;
            case "files_mkdir" -> payload.get("path") instanceof String;
            case "notebook_write" -> switch (String.valueOf(payload.get("op"))) {
                case "create" -> payload.get("new") instanceof Map<?, ?> made && made.get("tabId") instanceof String
                        && made.get("title") instanceof String title && payload.get("markdown") instanceof String md
                        && md.length() + title.length() <= MARKDOWN_MAX;
                case "append" -> payload.get("pageId") instanceof String
                        && payload.get("markdown") instanceof String md && md.length() <= MARKDOWN_MAX;
                default -> false;
            };
            default -> null;
        };
    }

    /**
     * The tools here that may run unasked in a run holding {@code U}: none. §15's one exception, adding a to-do with a
     * source the run read, is To-do's per-call class above, from deskd's look (Security's ATA-L1).
     */
    static boolean afterUntrusted(String tool) {
        return false;
    }

    /**
     * Whether the call lands inside the switch's place: a new page's tab, or the tab of the page an append goes to as
     * deskd's look found it ({@code target.tabId}), equal to the switch's tab id; a Files path inside the switch's folder,
     * part by part and at least one part below it. desk-agent's first check: deskd checks the place again where the write
     * happens, by its own record of the switch. To-do's group has no place: its switch alone, with deskd's per-call class.
     *
     * @param switches the agent's switches; a group's place null is no place, which nothing is inside
     */
    public boolean inPlace(Classified call, String group, Switches switches) {
        if (call == null || group == null || switches == null) {
            return false;
        }
        String tool = call.decl().name();
        Map<String, Object> payload = call.payload();
        return switch (tool) {
            case "notebook_write" -> switches.notebookTab() != null && switches.notebookTab().equals(
                    "create".equals(payload.get("op"))
                            ? (payload.get("new") instanceof Map<?, ?> made ? made.get("tabId") : null)
                            : (call.target() == null ? null : call.target().get("tabId")));
            case "files_write", "files_mkdir" -> payload.get("path") instanceof String path
                    && inside(path, switches.filesFolder());
            case "todo_add", "todo_update", "todo_close" -> "todos".equals(group);
            default -> lenient && groups.containsKey(tool);
        };
    }

    /**
     * Whether a Files path is inside a folder, by their parts: the folder's every part equal to the path's, and the path
     * at least one part longer. A path with an empty part, {@code .} or {@code ..} anywhere is inside nothing (deskd's
     * own rules refuse it anyway); case and look-alike characters count, so {@code research} and {@code Reѕearch} aren't
     * {@code Research}.
     */
    static boolean inside(String path, String folder) {
        List<String> p = parts(path);
        List<String> f = parts(folder);
        if (p == null || f == null || f.isEmpty() || p.size() <= f.size()) {
            return false;
        }
        return p.subList(0, f.size()).equals(f);
    }

    /** A path's parts, or null for one that's no path: empty parts inside it, {@code .}, {@code ..}, a backslash. */
    static List<String> parts(String path) {
        if (path == null || path.isEmpty() || path.length() > MAX_PATH || path.indexOf('\\') >= 0
                || path.indexOf('\0') >= 0) {
            return null;
        }
        String trimmed = path.startsWith("/") ? path.substring(1) : path;
        if (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        List<String> out = new ArrayList<>();
        if (trimmed.isEmpty()) {
            return out;
        }
        for (String part : trimmed.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) {
                return null;
            }
            out.add(part);
        }
        return out;
    }

    /** The map, tool to group. */
    public Map<String, String> groups() {
        return groups;
    }

    /**
     * One agent's switches as the member chose them: the groups on (each with its app on) and their places.
     *
     * @param on the groups switched on
     * @param notebookTab the Notebook switch's tab id, or null
     * @param filesFolder the Files switch's folder, relative to the Files' top with no slash at either end, or null
     */
    public record Switches(Set<String> on, String notebookTab, String filesFolder) {
        public static final Switches OFF = new Switches(Set.of(), null, null);

        public Switches {
            on = on == null ? Set.of() : Set.copyOf(on);
        }

        /** The groups only, with no place known: for tests of tools that have none. */
        public static Switches groups(Set<String> on) {
            return new Switches(on, null, null);
        }

        /** No tab or folder in logs. */
        @Override
        public String toString() {
            return "Switches" + on;
        }
    }
}
