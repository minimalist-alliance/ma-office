package com.minimalistalliance.desk.agent.run;

import com.minimalistalliance.desk.agent.approval.Verdict;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.tool.Classified;
import com.minimalistalliance.desk.agent.tool.RunContext;
import java.util.List;
import java.util.Map;

/**
 * What a run writes down as it goes, so a kill leaves a trace and the reply keeps what it had (durable runs, Design 1's
 * seam): its reply's text and chips at each step, and a record of each call before it's sent and as it settles. The run
 * loop ({@code ManagerAgent}) calls these on the run's own thread, one call at a time. {@link RunCalls} is the desk's,
 * and its checkpoints ({@link RunCheckpoints}) are what a run picks up from after a restart ({@link Resume}).
 */
public interface RunRecords {

    /**
     * The run is on {@code step} (1 for its first model call), and its reply's text and chips so far are these: called
     * once a step's model call is done and before its calls run, and again after they have.
     */
    default void step(RunContext run, int step, String text, List<Map<String, Object>> chips) {}

    /**
     * Just before a call the gate let through runs: its record, {@code started}.
     *
     * @return the call's key, which a call deskd runs carries as its idempotency key; null with no records
     */
    default String started(RunContext run, Classified call, Verdict verdict) {
        return null;
    }

    /** The call came back, however: {@code done}, {@code failed}, or {@code interrupted} when it may have happened. */
    default void settled(RunContext run, String key, ToolResult result) {}

    /**
     * A step's plan (the sizing's checkpoint 1): written once its model call is back and its calls classified, before
     * any of them is asked or runs, with the run's taint and gate counts.
     */
    default void planned(RunContext run, Resume.Plan plan) {}

    /** The gate admitted the step: its verdicts, in the plan's order. */
    default void admitted(RunContext run, int step, List<Verdict> verdicts) {}

    /**
     * {@link #settled(RunContext, String, ToolResult)} with what the model reads and the chip's fields (the sizing's
     * checkpoint 3): the record's outcome and the result go down together. {@code key} is null for a call that never ran
     * (declined, refused), whose result is kept all the same.
     */
    default void settled(RunContext run, String key, ToolResult result, int step, int index, ToolResult forModel,
            Map<String, Object> fields) {
        settled(run, key, result);
    }

    /**
     * A call a restart left in flight is asked again now by its record's {@code key}: the call deskd runs carries it with
     * {@code retry: true}, so deskd answers with what it kept and never runs it again.
     */
    default void resending(RunContext run, String key) {}

    /** Nothing written: tests and runs without the gate. */
    RunRecords NONE = new RunRecords() {};
}
