package com.minimalistalliance.desk.agent.approval;

import com.minimalistalliance.desk.agent.tool.Classified;
import com.minimalistalliance.desk.agent.tool.RunContext;
import java.util.Objects;
import java.util.Set;
import java.util.function.Function;

/**
 * Whether a call that needs the member is asked on a card or done without asking under the member's own setting for that
 * agent (the owner's decision of Nov 12: auto-approve for low-risk writes, chosen per agent at setup; the draft ADR's §15,
 * built as its W3). <b>The default is to ask, always.</b> Only a group the member switched on for an agent lets anything
 * through, and then only what {@link LowRisk} covers, inside the switch's place.
 *
 * <p>The gate ({@link Approvals#admit}) asks this only for a call that would otherwise make a card, after every refusal
 * decided before asking and after the run's declines ({@code declined_before}), and within the counts (20 a run, 100 an
 * agent a day). It never sees a {@code read} or the agent's own, and nothing it answers can make a call that would be
 * refused run. A call it allows runs once with exactly the payload it judged, as {@link Verdict.Allowed}, with an
 * approval row of its own ({@code decidedBy: "auto"}); a tool deskd runs carries {@code auto: <group>} and that row's id,
 * which deskd checks against its own record of the member's switches, its own place check and counts before it runs
 * anything.
 */
@FunctionalInterface
public interface ApprovalPolicy {

    /**
     * @param call a call that would ask, not refused before asking
     * @param run its run
     * @return the group the member switched on that covers it ({@code notebook}, {@code files}, {@code todos}), or null to
     *     ask
     */
    String allows(Classified call, RunContext run);

    /** Ask, always: an agent whose member switched nothing on. */
    ApprovalPolicy ASK_ALWAYS = (call, run) -> null;

    /**
     * Each agent's own switches and their places, from {@code switches} (the member's choice: the groups on for that
     * agent, its tab and folder), over {@code lowRisk}, inside each switch's place ({@link LowRisk#inPlace}). Switches
     * that can't be read are all off.
     */
    static ApprovalPolicy perAgentWithPlaces(Function<String, LowRisk.Switches> switches, LowRisk lowRisk) {
        Objects.requireNonNull(switches, "switches");
        Objects.requireNonNull(lowRisk, "lowRisk");
        return (call, run) -> {
            String group = lowRisk.groupOf(call, run);
            if (group == null) {
                return null;
            }
            LowRisk.Switches on;
            try {
                on = switches.apply(run.agentId());
            } catch (RuntimeException e) {
                return null;
            }
            return on != null && on.on().contains(group) && lowRisk.inPlace(call, group, on) ? group : null;
        };
    }

    /**
     * The groups alone, with no place known: a tool with a place (every one of the ADR's) is never inside one, so this
     * lets through only what a test's class makes placeless ({@link LowRisk#forTest}). For tests.
     */
    static ApprovalPolicy perAgent(Function<String, Set<String>> switchedOn, LowRisk lowRisk) {
        Objects.requireNonNull(switchedOn, "switchedOn");
        return perAgentWithPlaces(id -> {
            Set<String> on = switchedOn.apply(id);
            return on == null ? null : LowRisk.Switches.groups(on);
        }, lowRisk);
    }
}
