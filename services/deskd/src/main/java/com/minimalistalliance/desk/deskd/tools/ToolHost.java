package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.IdempotencyStore;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.util.HexFormat;
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
 *   <li>deskd's own record of what the member chose for the agent on its setup screen ({@link AgentApps}): an agent the
 *       member hasn't set up gets nothing ({@code setup}), and an app they switched off nothing of that app
 *       ({@code scope}), whatever desk-agent says.
 *   <li>The run's taint ({@link RunLedger}): desk-agent's flags on the call, added to deskd's own, never removed.
 *   <li>deskd's own class for the call ({@link #classify}): the declaration's floor, what the area finds (a submit
 *       control is {@code send}, a pay-looking one {@code spend}, a navigation in the member's session {@code egress}),
 *       and the Rule of Two: any browse action in a run holding both U and S is {@code egress}.
 *   <li>For a class that asks, the member's approval ({@link #requireApproval}): deskd computes the hash itself over
 *       {@code {v: 1, agentId, runId, tool, context, payload}}, the payload being the arguments it received, and redeems
 *       a relayed approval for exactly that, once ({@link Tickets}). Or, for a call desk-agent says was done without
 *       asking, deskd's own record of the member's switch and its place, its own low-risk class, and its own ledger's
 *       counts and ids ({@link #requireAuto}, {@link AutoLedger}); the area then holds the call to the switch's place where
 *       it writes ({@link HostedTool#checksAuto}).
 * </ol>
 * A {@code look} call does steps 1 to 3 and answers deskd's classification, with nothing done.
 *
 * <p><b>Keys</b> (durable runs' seam; {@code API.md} §18, "Keys"): a call that carries a {@code key}, desk-agent's
 * UUIDv7 for it, has its reply kept by that key for 10 minutes after it ends, in RAM, as a client's {@code idem} is.
 * The same key again gets that reply and runs nothing, waiting while the first still runs; with {@code retry: true}, a
 * key deskd doesn't hold is refused {@code key_unknown}, never run, as it may have run before a restart or 10 minutes
 * ago. A first call with a key minted more than 10 minutes ago is refused {@code key_expired}. A {@code SAFE} tool's
 * reply isn't kept, unless its class rose to one that asks.
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
    private static final Pattern GROUP = Pattern.compile("[a-z][a-z0-9_]{0,31}");
    /** The groups whose switch has a place, which a call done without asking must be inside. */
    private static final java.util.Set<String> PLACED = java.util.Set.of("notebook", "files");
    /** desk-agent's key for a call: a UUIDv7 in lower case, whose first 48 bits are when it was made. */
    private static final Pattern KEY = Pattern.compile(
            "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
    /** How long a call's reply is kept by its key after it ends, and the oldest key a first call may carry. */
    public static final Duration KEY_TTL = Duration.ofMinutes(10);
    /** The method name a call's key is kept under, beside the agent's id. */
    private static final String TCALL = "tcall";

    /** Where a reply goes: the agent socket's writer. Must not block. */
    @FunctionalInterface
    public interface Wire {
        void send(Map<String, Object> message);
    }

    private final Map<String, HostedTool> areas = new ConcurrentHashMap<>();
    private final RunLedger ledger;
    private volatile java.util.function.BiConsumer<RunLedger.Run, Object> origins = (run, origin) -> {};
    private final Function<String, Caller> callers;
    private final BooleanSupplier guildDesk;
    private final BooleanSupplier ownerAdult;
    private final Semaphore slots = new Semaphore(AT_ONCE);
    private final Clock clock;
    /** Replies by their call's key, as {@code RpcDispatcher}'s are by {@code idem}: 4096 or 8 MiB at most. */
    private final IdempotencyStore keyed;
    private volatile Tickets tickets = Tickets.NONE;
    private volatile AccessRecord access = AccessRecord.NONE;
    /** The low-risk map, tool to group: {@link HostedDecls#LOW_RISK}, or a test's. */
    private volatile Map<String, String> lowRisk = HostedDecls.LOW_RISK;
    /** deskd's own ledger of the calls done without asking: ids once, the counts, what each made for its undo. */
    private final AutoLedger autoLedger;

    /**
     * deskd's own record of the member's standing choices for an agent: here, the auto-approve switches (the owner's
     * decision of Nov 12; the draft ADR's §15, "Checked twice", and its W0's {@code AccessRecord}), so desk-agent's word
     * that a call was done without asking is never enough. The ADR's W1 records the switches from the member's relayed
     * {@code agent.access.set} and keeps them on {@code /data/desk}; until then {@link #NONE} holds for every agent, and
     * every call that asks needs a relayed approval.
     */
    @FunctionalInterface
    public interface AccessRecord {
        /**
         * @param caller whom the call runs as, by deskd's own stamp
         * @param agentId the agent
         * @param group the switch's group: {@code notebook}, {@code files}, {@code todos}
         * @return whether the agent's owner switched that group on for it
         */
        boolean autoOn(Caller caller, String agentId, String group);

        /**
         * The switch's place by this record: the Notebook switch's tab id for {@code notebook}, the Files switch's folder
         * for {@code files}; null for none (and for {@code todos}, which has none).
         */
        default String place(String agentId, String group) {
            return null;
        }

        /** No agent has a switch on: every call that asks needs the member's approval. */
        AccessRecord NONE = (caller, agentId, group) -> false;
    }

    /**
     * @param callers whom an agent's calls run as: the owner for the desk's own agents, the member for a guild member's
     *     own agent, or null when there's no such member now
     * @param guildDesk whether this is a guild desk, which has Notebook only
     * @param ownerAdult whether the desk's owner is an adult: the Agent is off for a teen and while the band isn't known
     */
    public ToolHost(Clock clock, Function<String, Caller> callers, BooleanSupplier guildDesk, BooleanSupplier ownerAdult) {
        this.clock = clock;
        this.keyed = new IdempotencyStore(() -> clock.millis() * 1_000_000L, KEY_TTL.toNanos(),
                IdempotencyStore.DEFAULT_MAX_ENTRIES, IdempotencyStore.DEFAULT_MAX_BYTES);
        this.callers = callers;
        this.guildDesk = guildDesk;
        this.ownerAdult = ownerAdult;
        this.ledger = new RunLedger(clock, this::ended);
        this.autoLedger = new AutoLedger(clock);
    }

    /** deskd's own ledger of the calls done without asking. */
    public AutoLedger autoLedger() {
        return autoLedger;
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

    /** deskd's own record of the members' switches for their agents. Null is {@link AccessRecord#NONE}. */
    public void access(AccessRecord record) {
        this.access = record == null ? AccessRecord.NONE : record;
    }

    /** A test's low-risk map, in place of {@link HostedDecls#LOW_RISK}, which names none until the ADR's build does. */
    void lowRiskForTest(Map<String, String> groups) {
        this.lowRisk = Map.copyOf(groups);
    }

    public RunLedger ledger() {
        return ledger;
    }

    /**
     * Told of a call's {@code origin} ({@code {kind: "desk", envelopeId}} for a run another of the member's desks
     * started; {@code {kind: "maia", answers: [envelopeId, …]}} for Desk Maia's run, the answers in her thread), with the
     * run's entry, before the area hears the call: messages between desks give that run its message, or her answers, as
     * a To-do source, if deskd's own record agrees ({@code desks/DeskSources}). Never throws.
     */
    public void origins(java.util.function.BiConsumer<RunLedger.Run, Object> hook) {
        this.origins = hook == null ? (run, origin) -> {} : hook;
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

    private volatile AgentApps agentApps = AgentApps.NONE;

    /**
     * deskd's own record of each agent's apps, as the member chose them on the agent's setup screen and in its settings
     * (draft ADR "the Agent's tools and approvals", section 16): {@code agent/AccessRecord}, recorded only from the
     * member's relayed {@code agent.access.set}. Checked before any area sees a call, a look included. (The same record
     * answers the approvals core's auto-approve switches, its {@code autoOn}.)
     */
    public interface AgentApps {
        /**
         * @param area the tool's area: {@link HostedDecls#FILES}, {@link HostedDecls#BROWSER}, {@link HostedDecls#NOTEBOOK}
         * @return null to go on; {@code setup} for an agent the member hasn't set up (or whose record deskd lost), or
         *     {@code scope} for an app they switched off for it
         */
        String refusal(String agentId, String area);

        /** The agents deskd holds a member's setup for, for the hello; null to say nothing of access. */
        default List<String> recorded() {
            return null;
        }

        /** Until it's wired (a test of something else): no check, as before the setup screen. */
        AgentApps NONE = (agentId, area) -> null;
    }

    /** deskd's own record of each agent's apps. Null is {@link AgentApps#NONE}. */
    public void agentApps(AgentApps record) {
        this.agentApps = record == null ? AgentApps.NONE : record;
    }

    /** The hello's params. */
    public Map<String, Object> hello() {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("v", VERSION);
        p.put("tools", offered());
        // A Guild Desk does nothing without asking (the draft ADR's §15 rule 8): desk-agent turns every switch off too.
        p.put("guildDesk", guildDesk.getAsBoolean());
        // deskd keeps calls' replies by their key: desk-agent may ask again after a lost link (an older deskd says
        // nothing).
        p.put("keys", Map.of("ttlSec", KEY_TTL.toSeconds()));
        // Which agents deskd holds the member's setup for: desk-agent has any other wait for the member to confirm it.
        List<String> recorded = agentApps.recorded();
        if (recorded != null) {
            p.put("access", Map.of("recorded", recorded));
        }
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
                wire.send(keyed(message));
            } finally {
                slots.release();
            }
        });
    }

    /**
     * One call, by its key when it has one (the class's "Keys"): the reply kept for that key, or the call run once and
     * its reply kept. On the caller's thread; for tests too.
     */
    Map<String, Object> keyed(Map<String, Object> message) {
        Object id = message.get("id");
        Object rawKey = message.get("key");
        boolean retry = Boolean.TRUE.equals(message.get("retry"));
        if (rawKey == null || "look".equals(message.get("phase")) || HostedDecls.RUN_END.equals(message.get("tool"))) {
            // Nothing to keep: a look changes nothing, and the run's end is harmless twice. A retry needs its key.
            return retry && rawKey == null ? terr(id, ToolFailure.badArgs("key")) : handle(message);
        }
        String key;
        String agentId;
        try {
            if (!(id instanceof Number)) {
                throw ToolFailure.badArgs("id");
            }
            if (!(rawKey instanceof String k) || !KEY.matcher(k).matches()) {
                throw ToolFailure.badArgs("key");
            }
            key = k;
            agentId = idOf(message, "agentId");
        } catch (ToolFailure e) {
            return terr(id, e);
        }
        String fingerprint = fingerprint(message);
        try {
            while (true) {
                IdempotencyStore.Claim claim = keyed.claim(agentId, TCALL, key);
                if (!claim.isOwner()) {
                    IdempotencyStore.Stored stored = claim.await();
                    if (stored == null) {
                        // The first gave its claim up (a reply not kept): a retry finds nothing, a repeat claims again.
                        if (retry) {
                            return terr(id, ToolFailure.refused("key_unknown"));
                        }
                        continue;
                    }
                    return replay(stored, id, fingerprint);
                }
                if (retry) {
                    // deskd doesn't hold it: it may have run before a restart, or more than 10 minutes ago. Never
                    // again.
                    claim.abandon();
                    return terr(id, ToolFailure.refused("key_unknown"));
                }
                long made = Long.parseLong(key.substring(0, 8) + key.substring(9, 13), 16);
                // Older than deskd would keep a reply for: a stale call, never run. (One that seems to come from later is
                // a clock of another process's own, as a test's; desk-agent and deskd share the desk's.)
                if (clock.millis() - made > KEY_TTL.toMillis()) {
                    claim.abandon();
                    return terr(id, ToolFailure.refused("key_expired"));
                }
                Map<String, Object> reply;
                try {
                    reply = handle(message);
                } catch (RuntimeException e) {
                    claim.abandon();
                    throw e;
                }
                if (!kept(message, reply)) {
                    claim.abandon();
                    return reply;
                }
                Map<String, Object> stored = new LinkedHashMap<>();
                stored.put("fingerprint", fingerprint);
                Map<String, Object> copy = new LinkedHashMap<>(reply);
                copy.remove("id");
                stored.put("reply", copy);
                claim.finish(new IdempotencyStore.Stored(!"tres".equals(reply.get("t")), Json.bytes(stored)));
                return reply;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return terr(id, ToolFailure.unavailable("stopping"));
        }
    }

    /** The reply kept for a key, with this call's id; another call with the same key is refused. */
    private static Map<String, Object> replay(IdempotencyStore.Stored stored, Object id, String fingerprint) {
        Map<String, Object> kept;
        try {
            kept = Json.parseObject(stored.payload());
        } catch (JsonFormatException e) {
            return terr(id, new ToolFailure(RpcException.INTERNAL, "internal"));
        }
        if (!fingerprint.equals(kept.get("fingerprint")) || !(kept.get("reply") instanceof Map<?, ?> reply)) {
            return terr(id, ToolFailure.badArgs("key_mismatch"));
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> out = new LinkedHashMap<>((Map<String, Object>) reply);
        out.put("id", id);
        return out;
    }

    /**
     * Whether a call's reply is kept by its key: every reply of a {@code RETRY_BY_KEY} tool, refusals included, and a
     * {@code SAFE} tool's only when its class rose to one that asks. An unknown tool's refusal isn't.
     */
    private static boolean kept(Map<String, Object> message, Map<String, Object> reply) {
        HostedDecls.Decl decl = message.get("tool") instanceof String t ? HostedDecls.get(t) : null;
        if (decl == null) {
            return false;
        }
        if (decl.restart() != HostedDecls.Restart.SAFE) {
            return true;
        }
        ToolRisk risk = reply.get("r") instanceof Map<?, ?> r && r.get("risk") instanceof String w ? ToolRisk.fromWire(w)
                : null;
        return risk != null && risk.asks();
    }

    /**
     * What a key binds: the run, agent, tool, arguments, approval, switch and context. A different call with the same
     * key gets {@code key_mismatch}, never another call's reply.
     */
    static String fingerprint(Map<String, Object> message) {
        Map<String, Object> bound = new LinkedHashMap<>();
        for (String field : List.of("runId", "agentId", "tool", "args", "approval", "auto", "autoApprovalId",
                "context")) {
            bound.put(field, message.get(field));
        }
        try {
            return Canonical.sha256(bound);
        } catch (IllegalArgumentException | ClassCastException e) {
            // Not canonical (a fraction in the arguments): their bytes as received, which a repeat sends the same.
            try {
                return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Json.bytes(bound)));
            } catch (NoSuchAlgorithmException impossible) {
                throw new IllegalStateException(impossible);
            }
        }
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
                finished(runId, agentId, message.get("args"));
                ledger.end(runId);
                return tres(id, Map.of(), List.of());
            }
            HostedDecls.Decl decl = HostedDecls.get(tool);
            if (decl == null) {
                throw ToolFailure.notFound("tool");
            }
            Caller caller = callerFor(agentId);
            HostedTool area = areaFor(decl);
            requireAccess(agentId, decl);
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
            HostedCall.Approval approval = approvalOf(message);
            String auto = autoOf(message);
            // A call done without asking names its own approval id beside its group: required, so every unasked edit is
            // keyed and can be found by that id (the Notebook's key; the draft ADR's undo).
            String autoApprovalId = auto != null && approval == null && !look ? autoApprovalIdOf(message) : null;
            HostedCall call = new HostedCall(((Number) id).longValue(), runId, agentId, tool, args,
                    approval, look, caller, (String) context, autoApprovalId);
            RunLedger.Run run = ledger.join(runId, agentId, caller, list(message.get("taint")));
            if (message.get("origin") != null) {
                try {
                    origins.accept(run, message.get("origin"));
                } catch (RuntimeException e) {
                    // A source not recorded: a todo_add naming it is refused source_unknown, and nothing else changes.
                }
            }

            HostedTool.Look found = area.look(call, run);
            ToolRisk risk = classify(decl, found, run);
            if (look) {
                return tres(id, lookReply(risk, found), run.flags());
            }
            if (found.refusal() != null) {
                throw ToolFailure.forbidden(found.refusal());
            }
            boolean unasked = false;
            if (risk.asks()) {
                if (call.approval() == null && auto != null) {
                    HostedCall.AutoPlace place = requireAuto(call, decl, risk, found, run, auto, area);
                    // To-do's group has no place to carry, and its area keeps what its look decided by this very call
                    // (Security's TD-I1), so the call stays the same object.
                    if (!HostedDecls.TODO.equals(decl.area())) {
                        call = call.withAutoPlace(place);
                    }
                    unasked = true;
                } else {
                    requireApproval(call, found);
                }
            } else if (call.approval() != null) {
                // An approval on a call whose class doesn't ask was never redeemed: the area never sees it, so nothing an
                // area does on the member's yes (a spend's or a submit's binding, an approved payload's words) rests on
                // desk-agent's word alone (Security's BB-L2).
                call = call.withoutApproval();
            }
            HostedTool.Result result;
            try {
                result = area.run(call, run);
            } catch (ToolFailure e) {
                if (unasked) {
                    autoLedger.finish(call.autoApprovalId(), e.reason(), null);
                    if ("place".equals(e.reason())) {
                        // Outside the switch's place where it wrote (a page moved out of the tab since, say): as any other
                        // check of an unasked call, approval_unknown, and the model asks.
                        throw ToolFailure.forbidden("approval_unknown");
                    }
                }
                throw e;
            } catch (InterruptedException | RuntimeException e) {
                if (unasked) {
                    autoLedger.finish(call.autoApprovalId(), "unavailable", null);
                }
                throw e;
            }
            if (unasked) {
                autoLedger.finish(call.autoApprovalId(), "done", result.made());
            }
            run.addFromTool(decl.taints());
            run.addFromTool(result.taints());
            // To-do's provenance: the sources this result named are the run's, in deskd's own record (API.md §22), only
            // once their taint is the run's (Security's TD-I4).
            Provenance.record(decl.name(), result.content(), run);
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

    /**
     * A call desk-agent says was done without asking under the member's setting for its agent (the draft ADR's §15,
     * "Checked twice"): deskd runs it only if it isn't a Guild Desk (Security's AAW-L3); the call's group is the one
     * deskd's own declarations give its tool; its own record says the agent's owner switched that group on
     * ({@link AccessRecord}), read now, so a switch turned off holds for the next call; the call is in the low-risk class
     * by deskd's own class, look and taint ({@link HostedDecls#lowRisk}); the switch has its place, and the tool's area
     * holds the call to it where it writes ({@link HostedTool#checksAuto}); and its own ledger takes the call's id, which
     * it has never run, within the counts, all at once ({@link AutoLedger#reserve}). Otherwise {@code approval_unknown}
     * (or {@code approval_used}), as for a yes deskd never relayed, and the model asks.
     *
     * @return the switch's place, by deskd's own record, which the area holds the call to
     */
    HostedCall.AutoPlace requireAuto(HostedCall call, HostedDecls.Decl decl, ToolRisk risk, HostedTool.Look found,
            RunLedger.Run run, String group, HostedTool area) throws ToolFailure {
        if (guildDesk.getAsBoolean() || call.caller().isGuildMember()) {
            throw ToolFailure.forbidden("approval_unknown");
        }
        if (!group.equals(lowRisk.get(decl.name()))) {
            throw ToolFailure.forbidden("approval_unknown");
        }
        if (call.context() != null && !call.context().equals(found.context())) {
            throw ToolFailure.forbidden("approval_mismatch");
        }
        boolean on;
        String place;
        try {
            on = access.autoOn(call.caller(), call.agentId(), group);
            place = on ? access.place(call.agentId(), group) : null;
        } catch (RuntimeException e) {
            on = false;
            place = null;
        }
        // An area whose class is decided per call (To-do: the item's maker and run, the run's taint and who started it)
        // says which group this call is in; its own rule, never a map, then decides, within the same write-only frame,
        // and its group has no place. Every other area's class is the tool's (HostedDecls.lowRisk), and the area must
        // check the switch's place where it writes (checksAuto).
        boolean inClass = HostedDecls.TODO.equals(decl.area())
                ? group.equals(found.group()) && risk == ToolRisk.WRITE && "agent".equals(found.context())
                : HostedDecls.lowRisk(lowRisk, decl, risk, found.context(), run.untrusted(), call.args())
                        && area.checksAuto(decl.name());
        if (!on || !inClass || (PLACED.contains(group) && (place == null || place.isEmpty()))) {
            throw ToolFailure.forbidden("approval_unknown");
        }
        String argsSha;
        try {
            argsSha = Canonical.sha256(call.args());
        } catch (IllegalArgumentException e) {
            throw ToolFailure.badArgs("args");
        }
        String refused = autoLedger.reserve(call.autoApprovalId(), call.agentId(), call.runId(), decl.name(), group,
                argsSha);
        if ("unavailable".equals(refused)) {
            throw ToolFailure.unavailable("ledger");
        }
        if (refused != null) {
            throw ToolFailure.forbidden(refused);
        }
        return new HostedCall.AutoPlace(group, "notebook".equals(group) ? place : null,
                "files".equals(group) ? place : null);
    }

    /**
     * The member's undo of a call done without asking ({@code agent.approval.undo}, draft ADR §15), from deskd's own
     * ledger, never desk-agent's word: the call's agent must be one {@code caller} may decide for ({@code mayDecide}), and
     * it must have run and made something; then its area takes back exactly that, as {@code caller}, and the ledger stamps
     * it. Called by deskd's relay after its own checks of the session.
     *
     * @param beginEffect the mutation's point of no return, run right before the area acts
     * @return {@code {agentId, outcome}}: {@code ok}, or {@code already} for one the ledger holds as undone (desk-agent's
     *     row may not have heard)
     * @throws ToolFailure {@code not_found} {@code approval} (no such call, or not the caller's to decide),
     *     {@code conflict} {@code not_done}, or the area's refusal
     */
    public Map<String, Object> undoAuto(String approvalId, Caller caller,
            java.util.function.BiPredicate<Caller, String> mayDecide, Runnable beginEffect)
            throws ToolFailure, InterruptedException {
        AutoLedger.Entry entry = approvalId != null && AutoLedger.APPROVAL_ID.matcher(approvalId).matches()
                ? autoLedger.get(approvalId) : null;
        if (entry == null || caller == null || !mayDecide.test(caller, entry.agentId())) {
            throw ToolFailure.notFound("approval");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("agentId", entry.agentId());
        if (entry.undoneAt() != null) {
            out.put("outcome", "already");
            return out;
        }
        // A reservation with no end (deskd stopped while the call ran): it may have happened, and deskd doesn't know
        // what it made, so it can't take it back; never "it didn't happen" (Security's AAB-I6).
        if ("unknown".equals(entry.outcome())) {
            throw ToolFailure.refused("unknown");
        }
        HostedDecls.Decl decl = HostedDecls.get(entry.tool());
        // What it made is deskd's own record for Notebook's and Files'; To-do's store keeps its own events by the call's
        // approval id, which its undo goes by (API.md §22).
        boolean byId = decl != null && HostedDecls.TODO.equals(decl.area());
        if (!"done".equals(entry.outcome()) || (entry.made() == null && !byId)) {
            throw ToolFailure.refused("not_done");
        }
        HostedTool area = decl == null ? null : areas.get(decl.area());
        if (area == null || !area.available()) {
            throw ToolFailure.unavailable(decl == null ? "tool" : decl.area());
        }
        beginEffect.run();
        area.undoAuto(caller, entry);
        autoLedger.undone(approvalId, caller.isGuildMember() ? caller.memberId() : "owner");
        out.put("outcome", "ok");
        return out;
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

    /** The member's choice for the agent, by deskd's own record: never desk-agent's word. Any failure refuses. */
    private void requireAccess(String agentId, HostedDecls.Decl decl) throws ToolFailure {
        String refused;
        try {
            refused = agentApps.refusal(agentId, decl.area());
        } catch (RuntimeException e) {
            refused = "setup";
        }
        if (refused != null) {
            throw ToolFailure.forbidden(refused);
        }
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

    /** The group desk-agent says the call was done without asking under ({@code auto}), or null; malformed is bad_request. */
    private static String autoOf(Map<String, Object> message) throws ToolFailure {
        Object raw = message.get("auto");
        if (raw == null) {
            return null;
        }
        if (!(raw instanceof String group) || !GROUP.matcher(group).matches()) {
            throw ToolFailure.badArgs("auto");
        }
        return group;
    }

    /** The approval id desk-agent's gate gave a call it did without asking ({@code autoApprovalId}); missing or malformed is bad_request. */
    private static String autoApprovalIdOf(Map<String, Object> message) throws ToolFailure {
        // desk-agent's gate's own shape, never anything a member's approval or another key could be (Security's AAW-L2).
        if (!(message.get("autoApprovalId") instanceof String value) || !AutoLedger.APPROVAL_ID.matcher(value).matches()) {
            throw ToolFailure.badArgs("autoApprovalId");
        }
        return value;
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
        if (found.group() != null) {
            // The area's own per-call group (To-do's todos), for desk-agent's gate: it asks unless this names a switch on.
            r.put("group", found.group());
        }
        return r;
    }

    /** How a run ended, by desk-agent's {@code run_end}, to each area (Courier's cursor moves only on {@code done}). */
    @SuppressWarnings("unchecked")
    private void finished(String runId, String agentId, Object args) {
        Map<String, Object> end = args instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
        for (Map.Entry<String, HostedTool> area : areas.entrySet()) {
            try {
                // Only an area the member lets this agent use hears it (Security's CR-I1).
                if (agentApps.refusal(agentId, area.getKey()) != null) {
                    continue;
                }
                area.getValue().runFinished(runId, agentId, end);
            } catch (RuntimeException e) {
                log.warn("an area failed at a run's end: {}", e.getClass().getSimpleName());
            }
        }
    }

    private void ended(String runId) {
        autoLedger.runEnded(runId);
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
