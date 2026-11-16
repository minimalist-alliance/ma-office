package com.minimalistalliance.desk.agent.run;

import com.minimalistalliance.desk.agent.approval.Verdict;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.tool.Classified;
import com.minimalistalliance.desk.agent.tool.Restart;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Where a run picks up after a restart (durable runs, Design 1): what its checkpoint holds, as the run loop
 * ({@code ManagerAgent.resume}) reads it. A run is a model call, then that step's calls, then the next model call; so
 * a run picks up either before a model call ({@link #pending} null: it asks the model again, from {@link #conversation})
 * or inside a step whose plan was written ({@link #pending}): its settled calls keep their results, a call a restart
 * left in flight follows its {@link Restart} rule, and the rest run as they would have.
 *
 * @param runId the same run, so its spend, steps, approvals and records go on counting
 * @param conversation the thread it read at its start, then every finished step's calls and results
 * @param steps how many steps finished
 * @param text the reply's text so far
 * @param chips the reply's chips so far
 * @param usage the run's usage so far, or null
 * @param costMicroUsd the run's cost so far, or null
 * @param pending the step planned and not finished, or null
 */
public record Resume(String runId, List<ChatMessage> conversation, int steps, String text,
        List<Map<String, Object>> chips, Usage usage, Long costMicroUsd, Pending pending) {

    public Resume {
        Objects.requireNonNull(runId, "runId");
        conversation = List.copyOf(conversation);
        text = text == null ? "" : text;
        chips = chips == null ? List.of() : List.copyOf(chips);
    }

    /**
     * One step's plan (the sizing's checkpoint 1), written once its model call is back and before anything of it runs:
     * its text, its calls with their reasoning items, the answers some got before the gate ({@code early}: too many, a
     * malformed input, no such tool), and the rest as the policy classified them ({@code classified}, at call indexes
     * {@code at}). The class, payload and context of each are kept as judged, never judged again.
     *
     * @param reply the reply's text so far, this step's included
     * @param usage the run's usage so far, this step's model call included
     */
    public record Plan(int step, String text, String reply, List<ToolCall> calls, Map<Integer, ToolResult> early,
            List<Classified> classified, List<Integer> at, Usage usage, Long cost) {
        public Plan {
            calls = List.copyOf(calls);
            early = Map.copyOf(early);
            classified = List.copyOf(classified);
            at = List.copyOf(at);
        }

        /** No content in logs. */
        @Override
        public String toString() {
            return "Plan[" + step + ", " + calls.size() + " calls]";
        }
    }

    /**
     * A step whose plan was written and that didn't finish.
     *
     * @param verdicts the gate's verdicts for {@link Plan#classified}, in its order, or null if the step wasn't admitted
     *     (then it's admitted again, and approvals it asked before are found, not asked twice)
     * @param settled each call that came back, by call index: what the model reads and its chip's fields
     * @param inFlight each call a restart left {@code started}, by call id: its key and rule
     */
    public record Pending(Plan plan, List<Verdict> verdicts, Map<Integer, Settled> settled,
            Map<String, InFlight> inFlight) {
        public Pending {
            Objects.requireNonNull(plan, "plan");
            verdicts = verdicts == null ? null : List.copyOf(verdicts);
            settled = Map.copyOf(settled);
            inFlight = Map.copyOf(inFlight);
        }
    }

    /** A call that came back: what the model read and its chip's fields (the sizing's checkpoint 3). */
    public record Settled(ToolResult forModel, Map<String, Object> fields) {}

    /** A call left {@code started}: its record's key and what a restart does to it. */
    public record InFlight(String key, Restart restart) {}

    /**
     * What a run starts with, kept so it can resume: the thread it read, what started it, its spend cap and the chain of
     * agents' messages it's in. Its {@code instructions} aren't kept (null when read back): a resumed run is told them
     * as they are then, its memory lines included, so a line the member deleted meanwhile is gone from it too.
     */
    public record Start(String instructions, List<ChatMessage> thread, Map<String, Object> origin,
            Map<String, Object> chain, Long maxMicroUsd, boolean resumable) {}

    /** No content in logs. */
    @Override
    public String toString() {
        return "Resume[" + runId + ", " + steps + " steps" + (pending == null ? "" : ", in " + pending.plan()) + "]";
    }
}
