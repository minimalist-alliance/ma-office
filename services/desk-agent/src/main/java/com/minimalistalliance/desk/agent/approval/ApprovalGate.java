package com.minimalistalliance.desk.agent.approval;

import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.tool.Classified;
import com.minimalistalliance.desk.agent.tool.Risk;
import com.minimalistalliance.desk.agent.tool.RunContext;
import java.util.ArrayList;
import java.util.List;

/**
 * Where a step's calls wait for the member (draft ADR, sections 3 and 11). The run loop classifies a step's calls,
 * {@link #admit}s them all at once, runs each with its verdict in the step's order, then {@link #settle}s each.
 */
public interface ApprovalGate {

    /**
     * One verdict per call, in the step's order. A call the policy refused ({@link Classified#refusal()}) is
     * {@link Verdict.Refused} with that reason and no card. Every call that needs approval is asked at once, each as
     * its own approval, and this blocks until each is decided or expired.
     *
     * @throws InterruptedException when the run is stopped while waiting; its pending approvals are already expired
     */
    List<Verdict> admit(RunContext run, List<Classified> step) throws InterruptedException;

    /** What the call came to: an approved call's approval becomes {@code done} or {@code failed}. */
    void settle(Verdict verdict, ToolResult result);

    /** Just before a call that {@link Verdict#runs()} runs: an approved one is then running, for a restart's sake. */
    default void starting(Verdict verdict) {}

    /**
     * {@link #settle(Verdict, ToolResult)} with the call and its run, which the run loop calls for every call of a
     * step, run or not, so the gate can audit it and count it.
     */
    default void settle(RunContext run, Classified call, Verdict verdict, ToolResult result) {
        settle(verdict, result);
    }

    /**
     * The stand-in until the gate lands: a call the policy refused is refused with its reason, {@code read} and
     * {@code own} run, anything that would ask is refused {@code not_built}.
     */
    ApprovalGate NONE = new ApprovalGate() {
        @Override
        public List<Verdict> admit(RunContext run, List<Classified> step) {
            List<Verdict> out = new ArrayList<>(step.size());
            for (Classified c : step) {
                if (c.refusal() != null) {
                    out.add(new Verdict.Refused(c.refusal()));
                    continue;
                }
                boolean asks = c.risk().alwaysAsks() || (c.risk() == Risk.OWN && c.decl().isMemory() && run.untrusted());
                out.add(asks ? new Verdict.Refused("not_built") : Verdict.Auto.INSTANCE);
            }
            return out;
        }

        @Override
        public void settle(Verdict verdict, ToolResult result) {}
    };
}
