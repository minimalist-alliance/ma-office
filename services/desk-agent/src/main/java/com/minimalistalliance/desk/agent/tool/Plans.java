package com.minimalistalliance.desk.agent.tool;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.store.MessageRow;
import com.minimalistalliance.desk.agent.store.ToolStore;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * {@code plan_update}'s checklists (draft ADR section 2, "Running steps"; API.md section 18, a reply's {@code plan}): a
 * run's last plan, kept with its reply ({@code run_plans}) and shown on it, live while it streams. Not a scheduler: it
 * only shows where the run is. A step's words are the model's, shown as plain text: cut, hidden and control characters
 * removed.
 */
public final class Plans {

    private static final Logger log = LoggerFactory.getLogger(Plans.class);

    public static final int MAX_STEPS = 20;
    static final int MAX_STEP_CHARS = 200;
    static final Set<String> STATES = Set.of("todo", "doing", "done", "skipped");

    /** Where a changed plan goes: the reply, republished on its conversation. Must not block long. */
    @FunctionalInterface
    public interface Host {
        void changed(String agentId, String messageId);
    }

    private final ToolStore store;
    private volatile Host host = (agentId, messageId) -> {};
    private volatile boolean any;

    public Plans(ToolStore store) {
        this.store = store;
        try {
            any = store.anyPlans();
        } catch (SQLException e) {
            any = true;
        }
    }

    public void host(Host replies) {
        this.host = replies;
    }

    /**
     * The steps as given, checked: a list of at most {@link #MAX_STEPS} of {@code {text, state}}.
     *
     * @return the plan, or null if it isn't one
     */
    static List<Map<String, Object>> parse(Object raw) {
        if (!(raw instanceof List<?> steps) || steps.size() > MAX_STEPS) {
            return null;
        }
        List<Map<String, Object>> plan = new ArrayList<>();
        for (Object item : steps) {
            if (!(item instanceof Map<?, ?> step) || !(step.get("text") instanceof String text)
                    || !(step.get("state") instanceof String state) || !STATES.contains(state)) {
                return null;
            }
            String plain = Classified.plain(text);
            if (plain.length() > MAX_STEP_CHARS) {
                plain = plain.substring(0, MAX_STEP_CHARS);
            }
            if (plain.isEmpty()) {
                return null;
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("text", plain);
            out.put("state", state);
            plan.add(out);
        }
        return plan;
    }

    /**
     * The run's plan now, on its reply.
     *
     * @return the model's result
     */
    public String update(RunContext run, Object steps) throws SQLException {
        List<Map<String, Object>> plan = parse(steps);
        if (plan == null) {
            return null;
        }
        if (run.messageId() == null) {
            return "Plan noted.";
        }
        store.putPlan(run.messageId(), run.agentId(), new String(Json.bytes(plan), StandardCharsets.UTF_8));
        any = true;
        host.changed(run.agentId(), run.messageId());
        long done = plan.stream().filter(step -> "done".equals(step.get("state"))).count();
        return "Plan shown: " + done + " of " + plan.size() + " done.";
    }

    /** A reply's view gains its {@code plan}, if it has one. */
    public void decorate(Map<String, Object> view, MessageRow row) {
        if (!any || !"assistant".equals(row.role())) {
            return;
        }
        try {
            String json = store.plan(row.id());
            if (json != null) {
                view.put("plan", Json.parseObject(("{\"v\":" + json + "}").getBytes(StandardCharsets.UTF_8)).get("v"));
            }
        } catch (SQLException | RuntimeException | com.minimalistalliance.desk.agent.json.JsonFormatException e) {
            log.warn("a reply's plan wasn't read: {}", e.getClass().getSimpleName());
        }
    }
}
