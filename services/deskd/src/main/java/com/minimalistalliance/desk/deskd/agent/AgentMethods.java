package com.minimalistalliance.desk.deskd.agent;

import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.time.Duration;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * The client's {@code agent.*} methods (task 07's interface, API.md section 11), each relayed one to one to
 * desk-agent: {@code req} with the same method and params, and its {@code res} or {@code err} back unchanged. deskd
 * checks the session, {@code idem} and the rate limit as for any RPC, and only owner tokens may call. A mutation's
 * {@link RpcContext#beginEffect} runs on the link's writer, right before its request's bytes go ({@link AgentLink.Gate}),
 * so one that never got that far has no {@code mayHaveApplied}, whatever happened to it.
 *
 * <p>{@code agent.key.add} is the one that differs: deskd takes {@code secret} out of the params, checks it's 8 to 1024
 * bytes of printable ASCII with no space, and sends it to desk-agent in a KEY frame, with this desk's id. The secret
 * reached deskd as a JSON string, which can't be zeroed (ADR 0040 accepts that); its bytes are zeroed once sent.
 *
 * <p><b>Teens.</b> The Agent app is off for them (ma-platform age rules, section 3.2). While the owner's band is
 * {@code teen} every method answers {@code forbidden} with {@code reason: age_band}, and while it's unknown
 * {@code unavailable} with the same reason, right after the owner check, and before {@link RpcContext#beginEffect} or
 * anything reaches desk-agent. That goes ahead of {@code agent.key.add}'s look at the key, so a refused key never gets as far
 * as a copy of its bytes.
 *
 * <p><b>Guild members</b> (API.md section 14) call the same methods on a guild desk, and every request carries the
 * verified caller, which desk-agent goes by: a member sees and uses only their own agent and thread, under the guild's
 * limits. deskd adds two checks before anything goes. A member in the teen band gets {@code forbidden} with
 * {@code reason: age_band}, by their own token's flag. And the guild's keys, its limits and its audit log need the
 * Founder or the {@code manage_agents} grant ({@link #MANAGERS_ONLY}); anyone else gets {@code forbidden} with
 * {@code reason: grant}. {@code guild.usage.get}, each member's runs and dollars, is the Founder's and Officers'.
 */
final class AgentMethods {

    static final String OWNER = "owner";

    /** How long deskd waits for desk-agent: longer where desk-agent calls the provider. */
    record Waits(Duration call, Duration provider) {
        static final Waits DEFAULT = new Waits(Duration.ofSeconds(10), Duration.ofSeconds(30));
    }

    static final List<String> READS = List.of(
            "agent.providers", "agent.list", "agent.thread.get", "agent.seen", "agent.key.list", "agent.key.models",
            "agent.limits.get", "agent.audit.list",
            // Task 49, many agents (desk-agent docs/multi-agent.md, ADR 0047).
            "agent.get", "agent.caps", "agent.workspace.get", "agent.workspace.read", "agent.timer.list",
            "agent.icon.get", "agent.a2a.list",
            // Files attached to a message (desk-agent ADR 0049): the limits and what a model takes.
            "agent.attach.caps",
            // What an agent remembers, and its thread's summary (S-14): the owner's agents', or a member's own.
            "agent.memory.list",
            // The Agent's approvals (API.md section 18): a guild member sees only their own agent's.
            "agent.approvals.list", "agent.approval.get");
    static final List<String> MUTATIONS = List.of(
            "agent.create", "agent.update", "agent.bind", "agent.message.send", "agent.run.stop", "agent.key.add",
            "agent.key.delete", "agent.limits.set",
            // Task 49.
            "agent.delete", "agent.links.set", "agent.workspace.delete", "agent.workspace.share", "agent.timer.set",
            "agent.timer.delete", "agent.icon.upload", "agent.proposal.answer",
            // Files attached to a message: a chunk of one, taking one off, the owner's limits. Their params carry file
            // content, which deskd only relays: it never logs or audits params, and the idempotency store keeps results.
            "agent.attach.put", "agent.attach.remove", "agent.attach.caps.set",
            // Deleting what an agent remembers, one line or all (S-14). Their results carry no text.
            "agent.memory.delete", "agent.memory.clear",
            // The member's yes or no for one card (API.md section 18): a session that may act, and deskd's own ticket.
            "agent.approval.decide");

    /**
     * desk-agent's team methods ({@code Team.handles}) but {@code agent.get}: the desk owner's, so a guild member gets
     * {@code forbidden} with {@code reason: permission} here as from desk-agent. Keep with its list.
     */
    static final Set<String> TEAM_OWNER_ONLY = Set.of(
            "agent.create", "agent.delete", "agent.links.set", "agent.caps", "agent.workspace.get",
            "agent.workspace.read", "agent.workspace.delete", "agent.workspace.share", "agent.timer.list",
            "agent.timer.set", "agent.timer.delete", "agent.icon.upload", "agent.icon.get", "agent.a2a.list",
            "agent.proposal.answer",
            // The limits on attached files are the desk owner's to set; a member attaches within them.
            "agent.attach.caps.set");

    static final String KEY_ADD = "agent.key.add";
    static final String DECIDE = "agent.approval.decide";
    private static final String KEY_MODELS = "agent.key.models";
    /** What only the Founder or an Officer with manage_agents may do on a guild desk: the guild's keys, limits and audit. */
    static final Set<String> MANAGERS_ONLY = Set.of("agent.key.add", "agent.key.delete", "agent.limits.set", "agent.audit.list");
    /** Each member's runs and dollars, today and this month: the Founder's and the Officers'. */
    static final String GUILD_USAGE = "guild.usage.get";
    /** desk-agent's side of it, which no client can call by this name: {@link #READS} doesn't list it. */
    static final String AGENT_GUILD_USAGE = "agent.guild.usage";
    static final Set<String> SCOPES = Set.of(RpcPrincipal.OWNER, RpcPrincipal.GUILD_MEMBER);
    private static final int MIN_SECRET = 8;
    private static final int MAX_SECRET = 1024;
    private static final String AGE_BAND = "age_band";

    private final AgentLink link;
    private final Supplier<String> deskId;
    private final Waits waits;
    private final Supplier<AgeBand.Band> band;
    private final ApprovalTickets tickets;
    /** A member's current name for {@code guild.usage.get} rows: null when nothing knows it. */
    private volatile Function<String, String> memberNames = id -> null;

    AgentMethods(AgentLink link, Supplier<String> deskId, Waits waits, Supplier<AgeBand.Band> band,
            ApprovalTickets tickets) {
        this.link = link;
        this.deskId = deskId;
        this.waits = waits;
        this.band = band;
        this.tickets = tickets;
    }

    void register(RpcDispatcher dispatcher) {
        for (String method : READS) {
            Duration wait = method.equals(KEY_MODELS) ? waits.provider() : waits.call();
            dispatcher.register(method, SCOPES, (context, params) -> {
                requireCaller(context, method);
                return link.call(method, params, wait, session(context), null, caller(context));
            });
        }
        for (String method : MUTATIONS) {
            if (method.equals(KEY_ADD)) {
                dispatcher.registerMutation(method, SCOPES, this::keyAdd);
                continue;
            }
            if (method.equals(DECIDE)) {
                dispatcher.registerMutation(method, SCOPES, this::decide);
                continue;
            }
            dispatcher.registerMutation(method, SCOPES, (context, params) -> {
                requireCaller(context, method);
                requireAgent();
                return link.call(method, params, waits.call(), session(context), effect(context, method), caller(context));
            });
        }
        dispatcher.register(GUILD_USAGE, Set.of(RpcPrincipal.GUILD_MEMBER), (context, params) -> {
            Caller caller = context.principal().caller();
            if (!Caller.LEAD.equals(caller.role()) && !Caller.OFFICER.equals(caller.role())) {
                throw new RpcException(RpcException.FORBIDDEN, "Only the Founder and Officers see usage", Map.of("reason", "grant"));
            }
            return withNames(link.call(AGENT_GUILD_USAGE, Map.of(), waits.call(), session(context), null, caller.toJson()));
        });
    }

    void memberNames(Function<String, String> names) {
        this.memberNames = names;
    }

    /** Each member row of desk-agent's answer gets {@code name}, the member's name now, or null. */
    private Object withNames(Object answer) {
        if (!(answer instanceof Map<?, ?> map) || !(map.get("members") instanceof List<?> rows)) {
            return answer;
        }
        List<Object> named = new java.util.ArrayList<>();
        for (Object row : rows) {
            if (row instanceof Map<?, ?> r && r.get("memberId") instanceof String id) {
                Map<String, Object> copy = new LinkedHashMap<>();
                r.forEach((k, v) -> copy.put(String.valueOf(k), v));
                String name = memberNames.apply(id);
                copy.put("name", name);
                named.add(copy);
            } else {
                named.add(row);
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        map.forEach((k, v) -> out.put(String.valueOf(k), v));
        out.put("members", named);
        return out;
    }

    /** The mutation's point of no return, run by the link's writer right before the request's bytes go. */
    private AgentLink.Gate effect(RpcContext context, String method) {
        return () -> {
            context.beginEffect();
            requireCaller(context, method);
        };
    }

    /** As desk-agent gets it: read once per call, as the request's bytes are made. */
    private static Map<String, Object> caller(RpcContext context) {
        return context.principal().caller().toJson();
    }

    /**
     * Read live, as a refresh can change the session's token while a call runs: the owner, with the owner's band, or a
     * guild member, by their own teen flag and, for the guild's keys, limits and audit, their grants.
     */
    private void requireCaller(RpcContext context, String method) throws RpcException {
        RpcPrincipal principal = context.principal();
        if (principal.isGuildMember()) {
            requireMemberAge(principal.caller());
            if (TEAM_OWNER_ONLY.contains(method)) {
                throw new RpcException(RpcException.FORBIDDEN, "The desk's team belongs to its owner", Map.of("reason", "permission"));
            }
            if (MANAGERS_ONLY.contains(method) && !principal.caller().has(Caller.MANAGE_AGENTS)) {
                throw new RpcException(RpcException.FORBIDDEN, "The member's role doesn't allow this", Map.of("reason", "grant"));
            }
            return;
        }
        requireOwner(context);
        requireBand(band.get());
    }

    /**
     * The age check again, with the key already read: a guild member's own flag, or the owner's band. With no context
     * (a test's), the owner's band, which refuses before anything would use one.
     */
    private void requireAge(RpcContext context) throws RpcException {
        if (context != null && context.principal().isGuildMember()) {
            requireMemberAge(context.principal().caller());
        } else {
            requireBand(band.get());
        }
    }

    /** A guild member in the teen band, by their token: the Agent app is off for them, as for a teen's own desk. */
    static void requireMemberAge(Caller caller) throws RpcException {
        if (caller.teen()) {
            throw new RpcException(RpcException.FORBIDDEN, "The Agent app isn't available on this desk", Map.of("reason", AGE_BAND));
        }
    }

    /**
     * {@code agent.approval.decide} (API.md section 18). Only a session that may act decides: the owner's with input
     * (never a viewer's or, once they exist, a support session's), or a guild member's, whose token has no input because
     * a guild desk has no Browser, for their own agent (desk-agent answers {@code not_found} for any other). A yes makes
     * deskd's own ticket just before the request's bytes go, so it exists before desk-agent can act on it; desk-agent
     * refusing the decision takes it back. A tool deskd runs for desk-agent then runs only against that ticket
     * ({@link ApprovalTickets#redeem}).
     */
    private Object decide(RpcContext context, Map<String, Object> params) throws Exception {
        requireCaller(context, DECIDE);
        requireDecider(context);
        requireAgent();
        boolean approve = Boolean.TRUE.equals(params.get("approve"));
        String approvalId = params.get("approvalId") instanceof String id ? id : null;
        String sha256 = params.get("sha256") instanceof String sha ? sha : null;
        // Whether this call made the ticket: only then may its refusal take it back (a double click's second yes, which
        // desk-agent answers answered, must not take away the first's).
        java.util.concurrent.atomic.AtomicBoolean made = new java.util.concurrent.atomic.AtomicBoolean();
        AgentLink.Gate gate = () -> {
            context.beginEffect();
            requireCaller(context, DECIDE);
            requireDecider(context);
            if (approve) {
                made.set(tickets.record(approvalId, sha256, context.principal().caller()));
            }
        };
        Object answer;
        try {
            answer = link.call(DECIDE, params, waits.call(), session(context), gate, caller(context));
        } catch (RpcException e) {
            // desk-agent's own refusal: nothing was approved. Anything else (it may not have heard) keeps the ticket,
            // which lapses unused.
            if (made.get() && DECIDED_NOTHING.contains(e.code())) {
                tickets.forget(approvalId);
            }
            throw e;
        }
        if (made.get() && !(answer instanceof Map<?, ?> map && map.get("approval") instanceof Map<?, ?> approval
                && APPROVED.contains(approval.get("state")))) {
            tickets.forget(approvalId);
        }
        return answer;
    }

    /** desk-agent's refusals of a decision, which mean it approved nothing. */
    private static final Set<String> DECIDED_NOTHING = Set.of(RpcException.BAD_REQUEST, RpcException.NOT_FOUND,
            RpcException.CONFLICT, RpcException.FORBIDDEN, RpcException.TOO_LARGE);
    /** An approval's states after a yes: running, or already run. */
    private static final Set<Object> APPROVED = Set.of("approved", "done", "failed", "interrupted");

    /**
     * A session that may decide, read live: an owner token with input, or a guild member's (their tokens carry no
     * input, as there's no Browser to drive; desk-agent checks the agent is theirs). Else {@code forbidden} with
     * {@code reason: permission}, before desk-agent hears of it.
     */
    private static void requireDecider(RpcContext context) throws RpcException {
        RpcPrincipal principal = context.principal();
        if (principal.isGuildMember()) {
            Caller caller = principal.caller();
            if (caller == null || !Caller.GUILD_MEMBER.equals(caller.kind()) || caller.memberId() == null) {
                throw forbidden();
            }
            return;
        }
        if (!OWNER.equals(principal.scope()) || !principal.input()) {
            throw forbidden();
        }
    }

    private static String session(RpcContext context) {
        return context.principal().sessionId();
    }

    private Object keyAdd(RpcContext context, Map<String, Object> params) throws Exception {
        requireCaller(context, KEY_ADD);
        return sendKey(context, params, secret(params.get("secret")));
    }

    /** Whatever comes of it, the key's bytes are zeroed. The band is asked again, as it can have changed since the key was read. */
    Object sendKey(RpcContext context, Map<String, Object> params, byte[] secret) throws Exception {
        try {
            Map<String, Object> head = new LinkedHashMap<>(params);
            head.remove("secret");
            head.put("deskId", deskId.get());
            requireAge(context);
            requireAgent();
            return link.callWithKey(KEY_ADD, head, secret, waits.provider(), session(context), effect(context, KEY_ADD), caller(context));
        } finally {
            Arrays.fill(secret, (byte) 0);
        }
    }

    /** The key's bytes, or {@code bad_request} with {@code key_malformed}, which says nothing of the key itself. */
    static byte[] secret(Object value) throws RpcException {
        if (!(value instanceof String text) || text.length() < MIN_SECRET || text.length() > MAX_SECRET) {
            throw malformed();
        }
        byte[] bytes = new byte[text.length()];
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c <= ' ' || c > '~') {
                Arrays.fill(bytes, (byte) 0);
                throw malformed();
            }
            bytes[i] = (byte) c;
        }
        return bytes;
    }

    private static RpcException malformed() {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("reason", "key_malformed");
        details.put("detail", "format");
        return new RpcException(RpcException.BAD_REQUEST, "The key isn't in a key's format", details);
    }

    /**
     * Before a mutation is queued. With no desk-agent connected nothing can be sent, so the answer is {@code unavailable}
     * with {@code reason: unavailable} and no {@code mayHaveApplied}: the Agent isn't there, and nothing changed (API.md
     * sections 4 and 11), so the same key runs it once desk-agent is back (task 33 item 2). The link refuses the same
     * way, as its gate hasn't run; a link that drops after the gate, with the bytes going, says the write may have applied.
     */
    private void requireAgent() throws RpcException {
        if (!link.isConnected()) {
            throw new RpcException(RpcException.UNAVAILABLE, "desk-agent isn't running, so nothing changed", Map.of("reason", "unavailable"));
        }
    }

    /** The owner's band, read live: see the class's comment. */
    static void requireBand(AgeBand.Band band) throws RpcException {
        if (band == AgeBand.Band.TEEN) {
            throw new RpcException(RpcException.FORBIDDEN, "The Agent app isn't available on this desk", Map.of("reason", AGE_BAND));
        }
        if (band == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "The Agent app is waiting for the desk's settings", Map.of("reason", AGE_BAND));
        }
    }

    /** Read live: a refresh can change the session's token while a call runs. */
    private static void requireOwner(RpcContext context) throws RpcException {
        if (!OWNER.equals(context.principal().scope())) {
            throw forbidden();
        }
    }

    static RpcException forbidden() {
        return new RpcException(RpcException.FORBIDDEN, "The token doesn't allow this", Map.of("reason", "permission"));
    }
}
