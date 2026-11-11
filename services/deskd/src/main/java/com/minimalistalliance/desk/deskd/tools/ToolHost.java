package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.function.BooleanSupplier;
import java.util.function.Function;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The tools deskd runs for desk-agent over the agent socket (draft ADR "the Agent's tools and approvals", sections 3, 5
 * and 11; services/desk-agent/docs/proposals.md section 5, "Tool calls"). desk-agent sends {@code tcall}; this answers
 * {@code tres} or {@code terr}. No client can reach any of it: the client relay lists only {@code agent.*}, and these
 * come only from desk-agent's socket.
 *
 * <p><b>What it checks, in order,</b> before any area sees a call:
 * <ol>
 *   <li>The tool is in {@link HostedDecls}, its area is here and working, and the caller may use that area: a guild
 *       desk's agents get Notebook only. The caller is deskd's own stamp from the agent's id ({@code callers}), never
 *       anything desk-agent says. A teen's desk or a teen member gets nothing.
 *   <li>The run's taint ({@link RunLedger}): desk-agent's flags on the call, added to deskd's own, never removed.
 *   <li>deskd's own class for the call ({@link #classify}): the declaration's floor, what the area finds (a submit
 *       control is {@code send}, a pay-looking one {@code spend}, a navigation in the member's session {@code egress}),
 *       and the Rule of Two: any browse action in a run holding both U and S is {@code egress}.
 *   <li>For a class that asks, the member's approval ({@link #requireApproval}): deskd computes the hash itself over
 *       {@code {v: 1, agentId, runId, tool, context, payload}}, the payload being the arguments it received, and redeems
 *       a relayed approval for exactly that, once ({@link Tickets}).
 * </ol>
 * A {@code look} call does steps 1 to 3 and answers deskd's classification, with nothing done.
 *
 * <p>Each call runs on a virtual thread of its own, at most {@value #AT_ONCE} at once; the socket's reader never waits
 * for one. Nothing here logs arguments, results, paths, page text or URLs: a tool's name and an outcome word at most.
 */
public final class ToolHost {

    private static final Logger log = LoggerFactory.getLogger(ToolHost.class);

    /** deskd's announcement on each connection, a plain {@code req} an older desk-agent answers {@code not_found}. */
    public static final String HELLO = "desk.tools.hello";
    /** The protocol's version in the hello. */
    public static final int VERSION = 1;
    /** Calls running at once, desk-wide. More are refused {@code rate_limited}. */
    static final int AT_ONCE = 16;
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9_:.-]{1,128}");
    private static final Pattern HEX64 = Pattern.compile("[0-9a-f]{64}");

    /** Where a reply goes: the agent socket's writer. Must not block. */
    @FunctionalInterface
    public interface Wire {
        void send(Map<String, Object> message);
    }

    private final Map<String, HostedTool> areas = new ConcurrentHashMap<>();
    private final RunLedger ledger;
    private final Function<String, Caller> callers;
    private final BooleanSupplier guildDesk;
    private final BooleanSupplier ownerAdult;
    private final Semaphore slots = new Semaphore(AT_ONCE);
    private volatile Tickets tickets = Tickets.NONE;

    /**
     * @param callers whom an agent's calls run as: the owner for the desk's own agents, the member for a guild member's
     *     own agent, or null when there's no such member now
     * @param guildDesk whether this is a guild desk, which has Notebook only
     * @param ownerAdult whether the desk's owner is an adult: the Agent is off for a teen and while the band isn't known
     */
    public ToolHost(Clock clock, Function<String, Caller> callers, BooleanSupplier guildDesk, BooleanSupplier ownerAdult) {
        this.callers = callers;
        this.guildDesk = guildDesk;
        this.ownerAdult = ownerAdult;
        this.ledger = new RunLedger(clock, this::ended);
    }

    /** Adds an area: {@link HostedDecls#FILES}, {@link HostedDecls#BROWSER} or {@link HostedDecls#NOTEBOOK}. */
    public ToolHost area(String name, HostedTool tool) {
        areas.put(name, tool);
        return this;
    }

    /** deskd's ledger of the approvals it relayed. Until it's set, nothing that asks can run. */
    public void tickets(Tickets ledgerOfApprovals) {
        this.tickets = ledgerOfApprovals;
    }

    public RunLedger ledger() {
        return ledger;
    }

    /** The tools this desk can run now, for the hello: by area, and Notebook alone on a guild desk. */
    public List<String> offered() {
        List<String> names = new ArrayList<>();
        for (HostedDecls.Decl decl : HostedDecls.ALL.values()) {
            HostedTool area = areas.get(decl.area());
            if (area != null && area.available() && area.offers(decl.name()) && areaAllowed(decl.area())) {
                names.add(decl.name());
            }
        }
        return names;
    }

    /** The hello's params. */
    public Map<String, Object> hello() {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("v", VERSION);
        p.put("tools", offered());
        return p;
    }

    /**
     * One {@code tcall}, from the socket's reader: answered on a thread of its own. Never blocks.
     *
     * @param message the whole frame, {@code t} included
     */
    public void onCall(Map<String, Object> message, Wire wire) {
        if (!slots.tryAcquire()) {
            wire.send(terr(message.get("id"), new ToolFailure(RpcException.RATE_LIMITED, "tools")));
            return;
        }
        Thread.ofVirtual().name("agent-tool").start(() -> {
            try {
                wire.send(handle(message));
            } finally {
                slots.release();
            }
        });
    }

    /** Every run ends, as when deskd stops. */
    public void close() {
        ledger.endAll();
    }

    /** One call, answered: {@code tres} or {@code terr}. On the caller's thread; for tests too. */
    Map<String, Object> handle(Map<String, Object> message) {
        Object id = message.get("id");
        try {
            if (!(id instanceof Number)) {
                throw ToolFailure.badArgs("id");
            }
            String tool = Json.string(message, "tool");
            String runId = idOf(message, "runId");
            String agentId = idOf(message, "agentId");
            if (HostedDecls.RUN_END.equals(tool)) {
                ledger.end(runId);
                return tres(id, Map.of(), List.of());
            }
            HostedDecls.Decl decl = HostedDecls.get(tool);
            if (decl == null) {
                throw ToolFailure.notFound("tool");
            }
            Caller caller = callerFor(agentId);
            HostedTool area = areaFor(decl);
            if (!area.offers(decl.name())) {
                throw ToolFailure.unavailable(decl.name());
            }
            Object rawArgs = message.get("args");
            if (rawArgs != null && !(rawArgs instanceof Map<?, ?>)) {
                throw ToolFailure.badArgs("args");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> args = rawArgs == null ? Map.of() : (Map<String, Object>) rawArgs;
            boolean look = "look".equals(message.get("phase"));
            Object context = message.get("context");
            if (context != null && !(context instanceof String)) {
                throw ToolFailure.badArgs("context");
            }
            HostedCall call = new HostedCall(((Number) id).longValue(), runId, agentId, tool, args,
                    approvalOf(message), look, caller, (String) context);
            RunLedger.Run run = ledger.join(runId, agentId, caller, list(message.get("taint")));

            HostedTool.Look found = area.look(call, run);
            ToolRisk risk = classify(decl, found, run);
            if (look) {
                return tres(id, lookReply(risk, found), run.flags());
            }
            if (found.refusal() != null) {
                throw ToolFailure.forbidden(found.refusal());
            }
            if (risk.asks()) {
                requireApproval(call, found);
            }
            HostedTool.Result result = area.run(call, run);
            run.add(decl.taints());
            run.add(result.taints());
            Map<String, Object> r = new LinkedHashMap<>(result.chip());
            r.put("content", result.content());
            List<String> added = new ArrayList<>(decl.taints());
            for (String taint : result.taints()) {
                if (!added.contains(taint)) {
                    added.add(taint);
                }
            }
            r.put("taints", added);
            r.put("risk", risk.wireName());
            return tres(id, r, run.flags());
        } catch (ToolFailure e) {
            log.debug("agent tool refused: {} {}", message.get("tool") instanceof String t && HostedDecls.get(t) != null
                    ? t : "?", e.reason());
            return terr(id, e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return terr(id, ToolFailure.unavailable("stopping"));
        } catch (RuntimeException e) {
            log.warn("agent tool failed: {}", e.getClass().getSimpleName());
            return terr(id, new ToolFailure(RpcException.INTERNAL, "internal"));
        }
    }

    /**
     * deskd's class for a call: never below the declaration's, raised by what the area found, and the Rule of Two: a
     * browse action ({@code browser_open}, {@code _click}, {@code _type}, {@code _press}, {@code _back}; never a read,
     * the tab list or a close) in a run that holds both untrusted content (U) and the member's private data (S) is
     * {@code egress}. A {@code spend} stays {@code spend}, which asks one at a time and never from an unattended run.
     */
    static ToolRisk classify(HostedDecls.Decl decl, HostedTool.Look found, RunLedger.Run run) {
        ToolRisk risk = decl.floor().atLeast(found.risk());
        if (decl.browse() && run.untrusted() && run.privateData() && risk != ToolRisk.SPEND) {
            risk = risk.atLeast(ToolRisk.EGRESS);
        }
        return risk;
    }

    /**
     * The second check of an approval (draft ADR section 3, "deskd checks again"): the call carries an approval; the hash
     * deskd computes over what it received matches the one the member approved; and deskd's own ledger redeems that
     * approval for this agent, once. A wrong or compromised desk-agent can't approve itself.
     */
    void requireApproval(HostedCall call, HostedTool.Look found) throws ToolFailure {
        HostedCall.Approval approval = call.approval();
        if (approval == null) {
            throw ToolFailure.forbidden("approval_required");
        }
        String computed;
        try {
            computed = hash(call.agentId(), call.runId(), call.tool(), found.context(), call.args());
        } catch (IllegalArgumentException e) {
            throw ToolFailure.badArgs("args");
        }
        if (!computed.equals(approval.sha256())
                || (call.context() != null && !call.context().equals(found.context()))) {
            throw ToolFailure.forbidden("approval_mismatch");
        }
        String refused = tickets.redeem(approval.approvalId(), computed, call.agentId(), call.runId(), call.tool(),
                found.context(), call.args());
        if (refused != null) {
            throw ToolFailure.forbidden(refused);
        }
    }

    /** The hash an approval binds: SHA-256 of the canonical JSON of {@code {v: 1, agentId, runId, tool, context, payload}}. */
    public static String hash(String agentId, String runId, String tool, String context, Map<String, Object> payload) {
        Map<String, Object> bound = new LinkedHashMap<>();
        bound.put("v", 1);
        bound.put("agentId", agentId);
        bound.put("runId", runId);
        bound.put("tool", tool);
        bound.put("context", context);
        bound.put("payload", payload);
        return Canonical.sha256(bound);
    }

    private Caller callerFor(String agentId) throws ToolFailure {
        Caller caller = callers.apply(agentId);
        if (caller == null) {
            throw ToolFailure.forbidden("member");
        }
        if (caller.isGuildMember() ? caller.teen() : !ownerAdult.getAsBoolean()) {
            throw ToolFailure.forbidden("age_band");
        }
        return caller;
    }

    private HostedTool areaFor(HostedDecls.Decl decl) throws ToolFailure {
        if (!areaAllowed(decl.area())) {
            throw ToolFailure.forbidden("scope");
        }
        HostedTool area = areas.get(decl.area());
        if (area == null || !area.available()) {
            throw ToolFailure.unavailable(decl.area());
        }
        return area;
    }

    /** A guild desk has no Files and no Browser for agents (ADR 0080, draft ADR section 8). */
    private boolean areaAllowed(String area) {
        return !guildDesk.getAsBoolean() || HostedDecls.NOTEBOOK.equals(area);
    }

    private static HostedCall.Approval approvalOf(Map<String, Object> message) throws ToolFailure {
        Object raw = message.get("approval");
        if (raw == null) {
            return null;
        }
        if (!(raw instanceof Map<?, ?> map) || !(map.get("approvalId") instanceof String approvalId)
                || !ID.matcher(approvalId).matches() || !(map.get("sha256") instanceof String sha)
                || !HEX64.matcher(sha).matches()) {
            throw ToolFailure.badArgs("approval");
        }
        return new HostedCall.Approval(approvalId, sha);
    }

    private static String idOf(Map<String, Object> message, String key) throws ToolFailure {
        if (!(message.get(key) instanceof String value) || !ID.matcher(value).matches()) {
            throw ToolFailure.badArgs(key);
        }
        return value;
    }

    private static Collection<?> list(Object value) {
        return value instanceof List<?> list ? list : List.of();
    }

    private static Map<String, Object> lookReply(ToolRisk risk, HostedTool.Look found) {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("risk", risk.wireName());
        r.put("context", found.context());
        r.put("target", found.target());
        r.put("payload", found.payload());
        r.put("before", found.before());
        r.put("refusal", found.refusal());
        return r;
    }

    private void ended(String runId) {
        for (HostedTool area : areas.values()) {
            try {
                area.runEnded(runId);
            } catch (RuntimeException e) {
                log.warn("an area failed to end a run: {}", e.getClass().getSimpleName());
            }
        }
    }

    static Map<String, Object> tres(Object id, Map<String, Object> r, List<String> taint) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tres");
        m.put("id", id);
        m.put("r", r);
        m.put("taint", taint);
        return m;
    }

    static Map<String, Object> terr(Object id, ToolFailure e) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "terr");
        m.put("id", id instanceof Number ? id : -1);
        m.put("code", e.code());
        m.put("details", e.details());
        return m;
    }

    /** Callers on a personal desk: the owner, for every agent. */
    public static Function<String, Caller> ownerOnly() {
        return agentId -> Caller.THE_OWNER;
    }
}
