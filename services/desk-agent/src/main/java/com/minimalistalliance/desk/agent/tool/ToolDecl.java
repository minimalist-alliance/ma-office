package com.minimalistalliance.desk.agent.tool;

import java.util.Collections;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * One tool, declared in code (draft ADR, section 1). A setting may switch a tool off; nothing may lower its class,
 * widen its scope or remove an approval.
 *
 * @param name the wire name, {@code snake_case}
 * @param words the member-facing template, filled from the call's target and arguments by the desk, never by the model:
 *     "Save {path} in your Files"
 * @param schema the JSON Schema of the input
 * @param scope one narrow scope from {@link #SCOPES}, or {@code browser:member:<site>}
 * @param risk the class: the floor for every call
 * @param taints what its result adds to the run
 * @param host where it runs
 * @param restart what a restart, or a lost link to deskd, does to a call of it that had started ({@link Restart})
 */
public record ToolDecl(String name, String words, Map<String, Object> schema, String scope, Risk risk,
        Set<Taint> taints, Host host, Restart restart) {

    /** Where a tool runs: in desk-agent's process, or in deskd over the agent socket. */
    public enum Host {
        DESK_AGENT,
        DESKD
    }

    /** The closed list of scopes; {@code browser:member:<site>} is the one with a parameter. */
    public static final Set<String> SCOPES = Set.of("workspace:self", "files:read", "files:write", "files:trash",
            "notebook:read", "notebook:write", "notebook:trash", "browser:agent", "agents:linked", "timer:self",
            "plan:self", "memory:self", "desks:message", "desks:answer", "todo:read", "todo:write", "courier:read",
            // Documents' index (deskd API.md §25): Desk Maia's docs_* tools, read only, as deskd's HostedDecls has them.
            "docs:read",
            // Desk Maia's own (API.md §23): what she reads of the office, what she shows, her question with choices.
            "office:read", "office:show", "maia:self");

    public ToolDecl {
        Objects.requireNonNull(name, "name");
        Objects.requireNonNull(words, "words");
        Objects.requireNonNull(scope, "scope");
        Objects.requireNonNull(risk, "risk");
        Objects.requireNonNull(host, "host");
        restart = restart == null ? Restart.defaultFor(host) : restart;
        if (!SCOPES.contains(scope) && !scope.startsWith("browser:member:")) {
            throw new IllegalArgumentException("unknown scope " + scope);
        }
        schema = schema == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(schema));
        taints = taints == null || taints.isEmpty() ? Set.of() : Collections.unmodifiableSet(EnumSet.copyOf(taints));
    }

    /**
     * A declaration that names no {@link Restart}: {@link Restart#defaultFor}, never {@link Restart#SAFE}. Every tool in
     * {@link ToolRegistry} names its own, which {@code ToolRegistryTest} pins.
     */
    public ToolDecl(String name, String words, Map<String, Object> schema, String scope, Risk risk, Set<Taint> taints,
            Host host) {
        this(name, words, schema, scope, risk, taints, host, null);
    }

    /** Whether this is the memory runner's save: {@code own}, but it asks in a run holding U. */
    public boolean isMemory() {
        return "memory:self".equals(scope);
    }
}
