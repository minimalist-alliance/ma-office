package com.minimalistalliance.desk.agent.access;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;

/**
 * What one agent may use, as the member chose it on the agent's setup screen and later in its settings (draft ADR "the
 * Agent's tools and approvals", section 16). Immutable; {@link AccessBook} keeps it.
 *
 * @param chosen whether the member has saved the setup screen: no run starts before (refused {@code setup})
 * @param setup why the screen shows while not chosen: {@link #NEW} (never set up), {@link #UPGRADE} (made before the
 *     screen existed), {@link #CONFIRM} (deskd lost its own copy, or the record didn't read back whole); null once chosen
 * @param apps the apps the agent may use; each one off takes that app's tools away
 * @param auto the "without asking" switches (section 15), each needing its app on
 * @param desks the ids of the member's other desks this agent may message, as the member switched them on (section 14);
 *     each also has its send half in {@code desk_grants}
 * @param updatedAt when the member last saved, ms; 0 for never
 */
public record AgentAccess(boolean chosen, String setup, Apps apps, Auto auto, List<String> desks, long updatedAt) {

    public static final String NEW = "new";
    public static final String UPGRADE = "upgrade";
    public static final String CONFIRM = "confirm";

    /** The app names on the wire and in the record, in the screen's order. */
    public static final List<String> APP_NAMES = List.of("notebook", "files", "browser", "courier", "todos");

    public AgentAccess {
        Objects.requireNonNull(apps, "apps");
        Objects.requireNonNull(auto, "auto");
        desks = desks == null ? List.of() : List.copyOf(new TreeSet<>(desks));
        if (chosen) {
            setup = null;
        } else if (setup == null) {
            setup = NEW;
        }
    }

    /**
     * The apps.
     *
     * @param courier Courier's read tools (section 12): off by default, as it's other people's words and the member's
     *     private messages at once
     * @param todos the to-do tools (section 13)
     */
    public record Apps(boolean notebook, boolean files, boolean browser, boolean courier, boolean todos) {

        /** A new agent's screen: everything on but Courier (section 16). */
        public static final Apps DEFAULTS = new Apps(true, true, true, false, true);
        /** What an agent made before the screen could use: Notebook, Files and the Browser (section 16). */
        public static final Apps LEGACY = new Apps(true, true, true, false, false);
        /** A guild member's own agent: Notebook alone (section 8). */
        public static final Apps GUILD = new Apps(true, false, false, false, false);
        public static final Apps NONE = new Apps(false, false, false, false, false);

        public boolean on(String app) {
            return switch (app) {
                case "notebook" -> notebook;
                case "files" -> files;
                case "browser" -> browser;
                case "courier" -> courier;
                case "todos" -> todos;
                default -> false;
            };
        }

        /** These apps with one changed. */
        Apps with(String app, boolean on) {
            return new Apps(app.equals("notebook") ? on : notebook, app.equals("files") ? on : files,
                    app.equals("browser") ? on : browser, app.equals("courier") ? on : courier,
                    app.equals("todos") ? on : todos);
        }

        /** Both at once: on only where both are. */
        public Apps and(Apps other) {
            return new Apps(notebook && other.notebook, files && other.files, browser && other.browser,
                    courier && other.courier, todos && other.todos);
        }

        Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            for (String app : APP_NAMES) {
                out.put(app, on(app));
            }
            return out;
        }
    }

    /**
     * The "without asking" switches (section 15), all off by default. A place is never the whole Notebook or all of
     * Files.
     *
     * @param notebookTab the Notebook tab whose additions run unasked, by id, or null for off
     * @param filesFolder the Files folder whose new files run unasked, relative to the Files' top, or null for off
     * @param todos adding to-dos, and ticking off ones it added
     */
    public record Auto(String notebookTab, String filesFolder, boolean todos) {
        public static final Auto OFF = new Auto(null, null, false);

        public boolean any() {
            return notebookTab != null || filesFolder != null || todos;
        }

        Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("notebook", notebookTab == null ? null : Map.of("tabId", notebookTab));
            out.put("files", filesFolder == null ? null : Map.of("folder", filesFolder));
            out.put("todos", todos);
            return out;
        }
    }

    /** Nothing at all on: what a first save's audit row counts from. */
    static final AgentAccess NOTHING = new AgentAccess(false, NEW, Apps.NONE, Auto.OFF, List.of(), 0);

    /** A new agent, before its screen is saved: the screen's defaults, not chosen. */
    public static AgentAccess fresh(boolean guildMember) {
        return new AgentAccess(false, NEW, guildMember ? Apps.GUILD : Apps.DEFAULTS, Auto.OFF, List.of(), 0);
    }

    /** An agent made before the screen: what it could use, not chosen, so its next run waits for the screen. */
    public static AgentAccess legacy(boolean guildMember) {
        return new AgentAccess(false, UPGRADE, guildMember ? Apps.GUILD : Apps.LEGACY, Auto.OFF, List.of(), 0);
    }

    /** A record that didn't read back whole: nothing chosen, the screen's defaults to start from, everything else off. */
    public static AgentAccess unreadable(boolean guildMember) {
        return new AgentAccess(false, CONFIRM, guildMember ? Apps.GUILD : Apps.DEFAULTS, Auto.OFF, List.of(), 0);
    }

    /** This choice, waiting for the member to confirm it again: deskd has no copy of it. Never more than it was. */
    public AgentAccess toConfirm() {
        return new AgentAccess(false, CONFIRM, apps, auto, desks, updatedAt);
    }

    /** Whether the agent may use this app now: chosen, and the app on. */
    public boolean allows(String app) {
        return chosen && app != null && apps.on(app);
    }

    /**
     * The app a tool belongs to, by its wire name, or null for a tool no app gates (the agent's own workspace, plan,
     * memory and team tools). {@code desk_message} is gated by the agent's desk grants, not an app.
     */
    public static String appOf(String tool) {
        if (tool == null) {
            return null;
        }
        if (tool.startsWith("files_")) {
            return "files";
        }
        if (tool.startsWith("notebook_")) {
            return "notebook";
        }
        if (tool.startsWith("browser_")) {
            return "browser";
        }
        if (tool.startsWith("courier_")) {
            return "courier";
        }
        if (tool.startsWith("todo_")) {
            return "todos";
        }
        return null;
    }

    /** What's hashed and stored: everything but {@code setup}'s {@code new} and {@code upgrade}, which aren't stored. */
    Map<String, Object> body() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("v", 1);
        body.put("chosen", chosen);
        body.put("confirm", CONFIRM.equals(setup));
        body.put("apps", apps.toJson());
        body.put("auto", auto.toJson());
        body.put("desks", new ArrayList<>(desks));
        body.put("updatedAt", updatedAt);
        return body;
    }

    /** From a stored body; null for one that isn't this shape, which the book reads as unreadable. */
    @SuppressWarnings("unchecked")
    static AgentAccess fromBody(Map<String, Object> body) {
        if (body == null || !Integer.valueOf(1).equals(asInt(body.get("v")))
                || !(body.get("chosen") instanceof Boolean chosen) || !(body.get("apps") instanceof Map<?, ?> a)
                || !(body.get("auto") instanceof Map<?, ?> u) || !(body.get("desks") instanceof List<?> d)
                || !(body.get("updatedAt") instanceof Number at)) {
            return null;
        }
        boolean[] on = new boolean[APP_NAMES.size()];
        for (int i = 0; i < on.length; i++) {
            if (!(a.get(APP_NAMES.get(i)) instanceof Boolean b)) {
                return null;
            }
            on[i] = b;
        }
        String tab = u.get("notebook") instanceof Map<?, ?> n && n.get("tabId") instanceof String t ? t : null;
        String folder = u.get("files") instanceof Map<?, ?> f && f.get("folder") instanceof String p ? p : null;
        if (!(u.get("todos") instanceof Boolean todos)) {
            return null;
        }
        List<String> desks = new ArrayList<>();
        for (Object id : d) {
            if (!(id instanceof String s)) {
                return null;
            }
            desks.add(s);
        }
        boolean confirm = Boolean.TRUE.equals(body.get("confirm"));
        return new AgentAccess(chosen, chosen ? null : confirm ? CONFIRM : NEW,
                new Apps(on[0], on[1], on[2], on[3], on[4]), new Auto(tab, folder, todos), desks, at.longValue());
    }

    private static Integer asInt(Object value) {
        return value instanceof Number n && n.doubleValue() == n.intValue() ? n.intValue() : null;
    }

    /** The wire's {@code access}, with the send halves and the answer halves as given. */
    public Map<String, Object> toJson(List<Map<String, Object>> sendHalves, List<Map<String, Object>> incoming) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("chosen", chosen);
        out.put("setup", setup);
        out.put("apps", apps.toJson());
        out.put("auto", auto.toJson());
        out.put("desks", sendHalves);
        out.put("incoming", incoming);
        out.put("updatedAt", updatedAt == 0 ? null : updatedAt);
        return out;
    }

    /** The apps that differ between two, for the audit row: {@code files:on}, {@code courier:off}. */
    static Set<String> changes(AgentAccess before, AgentAccess after) {
        Set<String> out = new TreeSet<>();
        for (String app : APP_NAMES) {
            if (before.apps.on(app) != after.apps.on(app)) {
                out.add(app + ":" + (after.apps.on(app) ? "on" : "off"));
            }
        }
        if ((before.auto.notebookTab == null) != (after.auto.notebookTab == null)
                || !Objects.equals(before.auto.notebookTab, after.auto.notebookTab)) {
            out.add("auto.notebook:" + (after.auto.notebookTab == null ? "off" : "on"));
        }
        if (!Objects.equals(before.auto.filesFolder, after.auto.filesFolder)) {
            out.add("auto.files:" + (after.auto.filesFolder == null ? "off" : "on"));
        }
        if (before.auto.todos != after.auto.todos) {
            out.add("auto.todos:" + (after.auto.todos ? "on" : "off"));
        }
        return out;
    }

    /** No ids, places or names in logs. */
    @Override
    public String toString() {
        return "AgentAccess[" + (chosen ? "chosen" : setup) + "]";
    }
}
