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
 */
public record HostedCall(long id, String runId, String agentId, String tool, Map<String, Object> args,
        Approval approval, boolean look, Caller caller, String context) {

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
