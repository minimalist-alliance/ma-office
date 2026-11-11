package com.minimalistalliance.desk.deskd.agent;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import java.time.Clock;
import java.time.Duration;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * deskd's own record of the member's yeses (API.md section 18, "deskd's own record"; draft ADR "the Agent's tools and
 * approvals", section 3, "deskd checks again"), in RAM only. A tool deskd runs for desk-agent (Browser, Files,
 * Notebook) runs only against one of these, once, so a wrong or compromised desk-agent can't approve itself.
 *
 * <p><b>Where a ticket comes from.</b> Only {@link AgentMethods}' relay of {@code agent.approval.decide} with
 * {@code approve: true}, from a client session deskd verified (the owner's with input, or a guild member's), just before
 * the request's bytes go to desk-agent: so the ticket exists before desk-agent can act on the yes. It holds the
 * {@code sha256} the app computed from the payload it showed and the verified caller. If desk-agent then refuses the
 * decision, the ticket is {@link #forget forgotten}. Nothing desk-agent sends can make one.
 *
 * <p><b>Redeeming one</b> ({@link #redeem}) needs all of: a ticket for that approval id, made within the last
 * {@link #LIFE}; never redeemed before; the SHA-256 of the canonical JSON of {@code {v: 1, agentId, runId, tool, context,
 * payload}}, computed here from the arguments the call brings, equal to the ticket's (and to the hash the call claims);
 * and the ticket's caller being the agent's owner: the desk's owner for an agent that isn't a member's, the member
 * whose id is the agent's id. A deskd restart loses every ticket, so a call after it fails {@code approval_unknown}
 * and the model asks again.
 *
 * <p>A redeemed ticket stays, marked used, until its time is up, so a second redeem is {@code approval_used}, and a
 * repeated decide (a retry) never re-arms it: {@link #record} keeps the first ticket for an id.
 */
public final class ApprovalTickets {

    /** How long a yes may wait for its tool. */
    public static final Duration LIFE = Duration.ofMinutes(10);
    /** The most tickets held; past it the oldest go. A session's decides are rate limited long before this. */
    static final int MAX = 2_000;

    private static final Pattern ID = Pattern.compile("ap-[a-z2-7]{20}");
    private static final Pattern SHA = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern MEMBER_AGENT = Pattern.compile("gm-[a-z0-9]{4,40}");

    /** Why a redeem was refused, as the tool's error code. */
    public enum Refusal {
        /** No ticket for that id: never relayed, refused by desk-agent, past its time, or lost with a restart. */
        APPROVAL_UNKNOWN,
        /** Redeemed before. */
        APPROVAL_USED,
        /** The arguments, the agent, the run, the tool or the context aren't what the member approved. */
        APPROVAL_MISMATCH;

        public String code() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    /** What a redeem came to: {@code refusal} null when the tool may run. */
    public record Redeemed(Refusal refusal) {
        static final Redeemed OK = new Redeemed(null);

        public boolean ok() {
            return refusal == null;
        }
    }

    private record Ticket(String sha256, Caller caller, long at, boolean used) {}

    private final Clock clock;
    private final Map<String, Ticket> tickets = new LinkedHashMap<>();

    public ApprovalTickets(Clock clock) {
        this.clock = Objects.requireNonNull(clock);
    }

    /**
     * A member's yes, about to go to desk-agent: its approval id, the hash their app computed, and who they are as
     * deskd verified it. An id or hash not in the right form makes no ticket (desk-agent refuses those anyway). The
     * first ticket for an id stays, so a retry never re-arms a used one.
     *
     * @return whether this made the ticket: only then may the same call {@link #forget} it
     */
    synchronized boolean record(String approvalId, String sha256, Caller caller) {
        if (approvalId == null || sha256 == null || caller == null || !ID.matcher(approvalId).matches()) {
            return false;
        }
        String sha = sha256.toLowerCase(Locale.ROOT);
        if (!SHA.matcher(sha).matches()) {
            return false;
        }
        long now = clock.millis();
        prune(now);
        if (tickets.containsKey(approvalId)) {
            return false;
        }
        while (tickets.size() >= MAX) {
            Iterator<String> oldest = tickets.keySet().iterator();
            oldest.next();
            oldest.remove();
        }
        tickets.put(approvalId, new Ticket(sha, caller, now, false));
        return true;
    }

    /**
     * desk-agent refused the yes that made this ticket (or answered it wasn't one): it goes, unless a tool already used
     * it. Only the call that made a ticket forgets it, so a repeated yes desk-agent answers {@code answered} never takes
     * away the first one's.
     */
    synchronized void forget(String approvalId) {
        Ticket ticket = approvalId == null ? null : tickets.get(approvalId);
        if (ticket != null && !ticket.used()) {
            tickets.remove(approvalId);
        }
    }

    /**
     * Before deskd runs a gated tool for desk-agent: whether the member approved exactly this call. Only a success
     * uses the ticket; a refusal leaves it as it was, so a wrong call can't burn the member's yes for the right one.
     *
     * @param approvalId the approval the call names
     * @param claimed the {@code sha256} the call names
     * @param agentId the agent the call is for
     * @param runId its run
     * @param tool the tool's wire name
     * @param context {@code agent} or {@code member:<site>}
     * @param args the arguments deskd received, which the tool will run with
     */
    public synchronized Redeemed redeem(String approvalId, String claimed, String agentId, String runId, String tool,
            String context, Map<String, Object> args) {
        long now = clock.millis();
        prune(now);
        Ticket ticket = approvalId == null ? null : tickets.get(approvalId);
        if (ticket == null) {
            return new Redeemed(Refusal.APPROVAL_UNKNOWN);
        }
        if (ticket.used()) {
            return new Redeemed(Refusal.APPROVAL_USED);
        }
        String computed;
        try {
            computed = hash(agentId, runId, tool, context, args);
        } catch (IllegalArgumentException | ClassCastException | NullPointerException e) {
            return new Redeemed(Refusal.APPROVAL_MISMATCH);
        }
        if (!computed.equals(ticket.sha256()) || claimed == null || !computed.equalsIgnoreCase(claimed)
                || !owns(ticket.caller(), agentId)) {
            return new Redeemed(Refusal.APPROVAL_MISMATCH);
        }
        tickets.put(approvalId, new Ticket(ticket.sha256(), ticket.caller(), ticket.at(), true));
        return Redeemed.OK;
    }

    /** The approval's hash, as desk-agent and the app compute it (API.md section 18, {@code sha256}). */
    static String hash(String agentId, String runId, String tool, String context, Map<String, Object> payload) {
        Map<String, Object> bound = new LinkedHashMap<>();
        bound.put("v", 1);
        bound.put("agentId", Objects.requireNonNull(agentId));
        bound.put("runId", Objects.requireNonNull(runId));
        bound.put("tool", Objects.requireNonNull(tool));
        bound.put("context", Objects.requireNonNull(context));
        bound.put("payload", Objects.requireNonNull(payload));
        return Canonical.sha256(bound);
    }

    /** The agent's owner: the desk's owner for the desk's agents, a member for their own agent only. */
    static boolean owns(Caller caller, String agentId) {
        if (agentId == null) {
            return false;
        }
        boolean memberAgent = MEMBER_AGENT.matcher(agentId).matches();
        if (Caller.OWNER.equals(caller.kind())) {
            return !memberAgent;
        }
        return Caller.GUILD_MEMBER.equals(caller.kind()) && memberAgent && agentId.equals(caller.memberId());
    }

    /** Tickets held, used or not: for tests and health. */
    synchronized int size() {
        prune(clock.millis());
        return tickets.size();
    }

    private void prune(long now) {
        tickets.values().removeIf(ticket -> now - ticket.at() >= LIFE.toMillis());
    }
}
