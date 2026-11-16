package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import java.util.Map;
import java.util.Objects;

/**
 * One {@code tcall} from desk-agent, its shape checked (services/desk-agent/docs/proposals.md section 5, "Tool calls").
 *
 * @param id desk-agent's id for the call, which {@code tres} or {@code terr} echoes
 * @param runId the run
 * @param agentId the agent the run is of
 * @param tool the tool's wire name
 * @param args the arguments: for a call that asked, exactly the approval's stored payload
 * @param approval the member's approval, or null for a call that didn't ask
 * @param look true for a look only: deskd's classification of the call, and nothing done
 * @param caller whom deskd runs it as, by deskd's own stamp from {@code agentId} and never from anything desk-agent sent:
 *     the desk's owner, or on a guild desk the member whose agent it is
 * @param context the context desk-agent's approval was asked in, {@code agent} or {@code member:<site>}, or null: deskd
 *     uses its own, and refuses an approved call whose context differs
 * @param autoApprovalId for a call desk-agent did without asking under the member's switch ({@code auto}), that call's own
 *     approval id from desk-agent's gate, shape-checked; null otherwise. A tool keys what it does by it as by a member's
 *     approval (the Notebook's edit key, {@code auto:<id>}), so it's done once and the draft ADR's undo finds it.
 * @param autoPlace for a call done without asking that {@link ToolHost#requireAuto} let through, the switch's place by
 *     deskd's own record, which the area holds the call to where it writes ({@link HostedTool#checksAuto}); null
 *     otherwise
 */
public record HostedCall(long id, String runId, String agentId, String tool, Map<String, Object> args,
        Approval approval, boolean look, Caller caller, String context, String autoApprovalId, AutoPlace autoPlace) {

    /** A call that wasn't done without asking. */
    public HostedCall(long id, String runId, String agentId, String tool, Map<String, Object> args, Approval approval,
            boolean look, Caller caller, String context) {
        this(id, runId, agentId, tool, args, approval, look, caller, context, null, null);
    }

    /** A call before deskd's own check of its switch: no place yet. */
    public HostedCall(long id, String runId, String agentId, String tool, Map<String, Object> args, Approval approval,
            boolean look, Caller caller, String context, String autoApprovalId) {
        this(id, runId, agentId, tool, args, approval, look, caller, context, autoApprovalId, null);
    }

    /**
     * The place of the member's switch a call done without asking runs under, by deskd's own record (draft ADR §15).
     *
     * @param group {@code notebook}, {@code files} or {@code todos}
     * @param tabId the Notebook switch's tab, for {@code notebook}
     * @param folder the Files switch's folder, for {@code files}: relative to the Files' top, no slash at either end
     */
    public record AutoPlace(String group, String tabId, String folder) {
        public AutoPlace {
            Objects.requireNonNull(group, "group");
        }

        /** No place in logs. */
        @Override
        public String toString() {
            return "AutoPlace[" + group + "]";
        }
    }

    /**
     * The same call without an approval: one whose class doesn't ask, so deskd never redeemed what it carried (Security's
     * BB-L2). An area takes {@link #approval} as the member's redeemed yes, never as desk-agent's word.
     */
    public HostedCall withoutApproval() {
        return approval == null ? this : new HostedCall(id, runId, agentId, tool, args, null, look, caller, context, autoApprovalId, autoPlace);
    }

    /** The same call, let through unasked under this place. */
    public HostedCall withAutoPlace(AutoPlace place) {
        return new HostedCall(id, runId, agentId, tool, args, approval, look, caller, context, autoApprovalId, place);
    }

    /** What desk-agent sends with a call the member approved. */
    public record Approval(String approvalId, String sha256) {
        public Approval {
            Objects.requireNonNull(approvalId, "approvalId");
            Objects.requireNonNull(sha256, "sha256");
        }
    }

    public HostedCall {
        Objects.requireNonNull(runId, "runId");
        Objects.requireNonNull(agentId, "agentId");
        Objects.requireNonNull(tool, "tool");
        args = args == null ? Map.of() : args;
        Objects.requireNonNull(caller, "caller");
    }

    /** No arguments in logs. */
    @Override
    public String toString() {
        return "HostedCall[" + id + ", " + tool + (look ? ", look" : "") + "]";
    }
}
