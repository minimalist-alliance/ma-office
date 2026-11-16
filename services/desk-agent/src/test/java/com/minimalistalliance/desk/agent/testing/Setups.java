package com.minimalistalliance.desk.agent.testing;

import com.minimalistalliance.desk.agent.service.AgentService;
import com.minimalistalliance.desk.agent.service.Caller;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The member's save of an agent's setup screen (draft ADR "the Agent's tools and approvals", section 16), for tests of
 * other things: every run needs it first. The screen's defaults: Notebook, Files, the Browser and To-dos on, Courier
 * off, nothing without asking, no other desk.
 */
public final class Setups {

    private Setups() {}

    /** {@code agent.access.set}'s params for the screen's defaults. */
    public static Map<String, Object> defaults(String agentId) {
        Map<String, Object> apps = new LinkedHashMap<>();
        apps.put("notebook", true);
        apps.put("files", true);
        apps.put("browser", true);
        apps.put("courier", false);
        apps.put("todos", true);
        Map<String, Object> auto = new LinkedHashMap<>();
        auto.put("notebook", null);
        auto.put("files", null);
        auto.put("todos", false);
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("agentId", agentId);
        p.put("apps", apps);
        p.put("auto", auto);
        return p;
    }

    /** A guild member's own agent: Notebook alone, as a Guild Desk gives it. */
    public static Map<String, Object> guildDefaults(String agentId) {
        Map<String, Object> p = defaults(agentId);
        @SuppressWarnings("unchecked")
        Map<String, Object> apps = (Map<String, Object>) p.get("apps");
        apps.put("files", false);
        apps.put("browser", false);
        apps.put("todos", false);
        return p;
    }

    /** The owner saves the agent's screen with its defaults. */
    public static void setUp(AgentService service, String agentId) throws Exception {
        service.call("agent.access.set", defaults(agentId), Caller.OWNER);
    }

    /** A guild member saves their own agent's screen. */
    public static void setUpMember(AgentService service, Caller member) throws Exception {
        service.call("agent.access.set", guildDefaults(member.memberId()), member);
    }
}
