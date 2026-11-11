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
     * One hosted tool.
     *
     * @param area which {@link HostedTool} runs it
     * @param scope its one narrow scope; {@code browser:member} stands for {@code browser:member:<site>}
     * @param floor its class, the least any call of it is
     * @param taints what every result adds to the run: {@code U}, {@code S}
     * @param browse a browse action, which the Rule of Two makes {@code egress} in a run holding both U and S
     */
    public record Decl(String name, String area, String scope, ToolRisk floor, Set<String> taints, boolean browse) {
        public Decl {
            Objects.requireNonNull(name);
            Objects.requireNonNull(area);
            Objects.requireNonNull(scope);
            Objects.requireNonNull(floor);
            taints = Set.copyOf(taints);
        }
    }

    private static final Set<String> NONE = Set.of();
    private static final Set<String> S = Set.of("S");
    private static final Set<String> U = Set.of("U");
    private static final Set<String> SU = Set.of("S", "U");

    /** Every hosted tool, by name, in the ADR's order. */
    public static final Map<String, Decl> ALL;

    static {
        Map<String, Decl> all = new LinkedHashMap<>();
        // Files: the member's /data/files, never .trash or .uploads; trash only, nothing permanent.
        put(all, new Decl("files_list", FILES, "files:read", ToolRisk.READ, S, false));
        put(all, new Decl("files_search", FILES, "files:read", ToolRisk.READ, S, false));
        put(all, new Decl("files_read", FILES, "files:read", ToolRisk.READ, SU, false));
        put(all, new Decl("files_write", FILES, "files:write", ToolRisk.WRITE, NONE, false));
        put(all, new Decl("files_mkdir", FILES, "files:write", ToolRisk.WRITE, NONE, false));
        put(all, new Decl("files_move", FILES, "files:write", ToolRisk.WRITE, NONE, false));
        put(all, new Decl("files_trash", FILES, "files:trash", ToolRisk.DELETE, NONE, false));
        // The Browser: the agent's own off-the-record context, or one granted site of the member's session.
        put(all, new Decl("browser_open", BROWSER, "browser:agent", ToolRisk.READ, U, true));
        put(all, new Decl("browser_read", BROWSER, "browser:agent", ToolRisk.READ, U, false));
        put(all, new Decl("browser_click", BROWSER, "browser:agent", ToolRisk.READ, U, true));
        put(all, new Decl("browser_type", BROWSER, "browser:agent", ToolRisk.READ, NONE, true));
        put(all, new Decl("browser_press", BROWSER, "browser:agent", ToolRisk.READ, U, true));
        put(all, new Decl("browser_back", BROWSER, "browser:agent", ToolRisk.READ, NONE, true));
        put(all, new Decl("browser_close", BROWSER, "browser:agent", ToolRisk.READ, NONE, false));
        put(all, new Decl("browser_tabs", BROWSER, "browser:agent", ToolRisk.READ, NONE, false));
        put(all, new Decl("browser_use_my_session", BROWSER, "browser:member", ToolRisk.EGRESS, S, false));
        // Notebook, as the agent's owner, under their grants on a guild desk.
        put(all, new Decl("notebook_search", NOTEBOOK, "notebook:read", ToolRisk.READ, S, false));
        put(all, new Decl("notebook_read", NOTEBOOK, "notebook:read", ToolRisk.READ, S, false));
        put(all, new Decl("notebook_write", NOTEBOOK, "notebook:write", ToolRisk.WRITE, NONE, false));
        put(all, new Decl("notebook_trash", NOTEBOOK, "notebook:trash", ToolRisk.DELETE, NONE, false));
        ALL = Collections.unmodifiableMap(all);
    }

    /** The one tool that isn't one: desk-agent's word that a run ended. */
    public static final String RUN_END = "run_end";

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
