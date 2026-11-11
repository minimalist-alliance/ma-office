package com.minimalistalliance.desk.agent.tool;

import com.minimalistalliance.desk.agent.provider.ToolCall;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The tool policy over {@link ToolRegistry} (draft ADR "the Agent's tools and approvals", sections 1, 3, 5 and 6): what
 * each call of a step is, before any of them runs. Its class is never below the declaration's ({@link Classified}
 * raises it anyway) and rises per call:
 * <ul>
 *   <li>for a tool deskd runs, by deskd's own look at it ({@code tcall} with {@code phase: "look"}, nothing done):
 *       a submit control is {@code send}, a pay-looking one {@code spend}, any navigation in the member's signed-in
 *       session {@code egress}, a click there at least {@code write}. deskd's look also gives the call's context,
 *       target, the exact payload an approval hashes, what it replaces, and a refusal decided before asking (a
 *       sensitive field, an off-site page in a granted session, a file already there), so nobody is asked for
 *       something that would be refused;
 *   <li>the Rule of Two, here as well as in deskd and the run loop: a browse action in a run that holds both untrusted
 *       content ({@code U}) and the member's private data ({@code S}) is {@code egress}; a {@code spend} stays one.
 * </ul>
 * {@code browser_use_my_session} is refused {@code origin} in a run a timer or another agent started (Security's S-14
 * rule), before deskd hears of it.
 * A switched-off tool is refused {@code off}; input its schema doesn't take is refused {@code input}, before deskd hears
 * of it. A name no tool has passes as the agent's own and does nothing: the run's tools answer it as unknown.
 */
public final class RegistryPolicy implements ToolPolicy {

    /** How long a look at a deskd-hosted call may take: deskd reads a file's hash or a page's element. */
    static final Duration LOOK_WAIT = Duration.ofSeconds(15);
    /** {@code follow_up}'s window (draft ADR section 2). */
    static final Duration FOLLOW_UP_MAX = Duration.ofDays(7);
    /** Contexts remembered for calls not yet run: a step has at most 16, and a desk a few runs at once. */
    private static final int REMEMBERED = 512;

    private final ToolRegistry registry;
    private final DeskLink desk;
    private final Clock clock;
    private final Map<String, String> contexts = new LinkedHashMap<>(16, 0.75f, false) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, String> eldest) {
            return size() > REMEMBERED;
        }
    };

    public RegistryPolicy(ToolRegistry registry, DeskLink desk, Clock clock) {
        this.registry = registry;
        this.desk = desk;
        this.clock = clock;
    }

    @Override
    public Classified classify(ToolCall call, RunContext run) {
        ToolDecl decl = registry.decl(call.name());
        if (decl == null) {
            // No such tool: the run's own tools answer it as unknown, and it does nothing. Every tool a run can be
            // offered is declared (ToolRegistryTest), so nothing real ever comes this way.
            return new Classified(call, new ToolDecl(call.name(), call.name(), null, "workspace:self", Risk.OWN,
                    Set.of(), ToolDecl.Host.DESK_AGENT), Risk.OWN, "agent", null, call.input(), null);
        }
        Map<String, Object> input = call.input();
        if (registry.switchedOff(decl.name())) {
            return refused(call, decl, "off");
        }
        if (Schemas.check(decl.schema(), input) != null) {
            return refused(call, decl, "input");
        }
        if (Classified.SESSION_GRANT.equals(decl.name()) && run.unattended()) {
            // Security's S-14 rule: the member's signed-in session only ever for a run the member started themselves.
            return refused(call, decl, "origin");
        }
        if (decl.host() == ToolDecl.Host.DESKD) {
            return hosted(call, decl, run);
        }
        return switch (decl.name()) {
            case "follow_up" -> followUp(call, decl);
            case "plan_update" -> new Classified(call, decl, decl.risk(), "agent", null, input, null);
            default -> new Classified(call, decl, decl.risk(), "agent", decl.isMemory() ? Map.of("kind", "memory")
                    : null, input, null);
        };
    }

    /** deskd's look, then the Rule of Two. Never runs anything. */
    private Classified hosted(ToolCall call, ToolDecl decl, RunContext run) {
        if (!desk.offered().contains(decl.name())) {
            return refused(call, decl, "unavailable");
        }
        Map<String, Object> look = new LinkedHashMap<>();
        look.put("runId", run.runId());
        look.put("agentId", run.agentId());
        look.put("tool", decl.name());
        look.put("args", call.input());
        look.put("taint", flags(run.taint()));
        look.put("phase", "look");
        DeskLink.Reply reply;
        try {
            reply = desk.call(look, LOOK_WAIT);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return refused(call, decl, "stopped");
        }
        if (!reply.ok()) {
            return refused(call, decl, reply.reason());
        }
        Map<String, Object> r = reply.r();
        Risk risk = decl.risk();
        Risk found = r.get("risk") instanceof String wire ? riskOf(wire) : null;
        if (found == null && r.get("risk") != null) {
            // A class desk-agent doesn't know is the highest there is, never a reason to ask less.
            found = Risk.EGRESS;
        }
        risk = risk.atLeast(found);
        risk = ruleOfTwo(decl, risk, run);
        String context = r.get("context") instanceof String c && (c.equals("agent") || c.startsWith("member:"))
                ? c : "agent";
        Map<String, Object> payload = map(r.get("payload"));
        if (payload == null) {
            payload = call.input();
        }
        String refusal = r.get("refusal") instanceof String word && !word.isBlank() ? word : null;
        remember(run.runId(), call.id(), context);
        return new Classified(call, decl, risk, context, map(r.get("target")), payload, map(r.get("before")),
                refusal);
    }

    /**
     * The Rule of Two (draft ADR section 6; Security's finding 2): a browse action in a run holding both {@code U} and
     * {@code S} is {@code egress}, which always asks and is never in an Approve all. A {@code spend} stays
     * {@code spend}, which also asks one at a time and never from an unattended run.
     */
    static Risk ruleOfTwo(ToolDecl decl, Risk risk, RunContext run) {
        if (ToolRegistry.BROWSE_ACTIONS.contains(decl.name()) && run.untrusted() && run.privateData()
                && risk != Risk.SPEND) {
            return risk.atLeast(Risk.EGRESS);
        }
        return risk;
    }

    /** {@code follow_up}: when, as an absolute time within 7 days, and the prompt. */
    private Classified followUp(ToolCall call, ToolDecl decl) {
        Map<String, Object> input = call.input();
        long now = clock.millis();
        Long at = null;
        if (input.get("inMinutes") instanceof Number minutes) {
            at = now + minutes.longValue() * 60_000L;
        } else if (input.get("at") instanceof String text) {
            try {
                at = OffsetDateTime.parse(text).toInstant().toEpochMilli();
            } catch (DateTimeParseException e) {
                try {
                    at = Instant.parse(text).toEpochMilli();
                } catch (DateTimeParseException again) {
                    at = null;
                }
            }
        }
        if (at == null || at <= now || at > now + FOLLOW_UP_MAX.toMillis()) {
            return refused(call, decl, "when");
        }
        String prompt = input.get("prompt") instanceof String p ? p.strip() : "";
        if (prompt.isEmpty()) {
            return refused(call, decl, "prompt");
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("at", at);
        payload.put("prompt", prompt);
        Map<String, Object> target = new LinkedHashMap<>();
        target.put("kind", "timer");
        target.put("at", at);
        target.put("when", Instant.ofEpochMilli(at).toString());
        return new Classified(call, decl, decl.risk(), "agent", target, payload, null);
    }

    /**
     * The context a call was looked at in, for its {@code tcall}: deskd checks it against its own. Taken once.
     *
     * @return {@code agent}, {@code member:<site>}, or null if it wasn't looked at
     */
    public String contextOf(String runId, String callId) {
        synchronized (contexts) {
            return contexts.remove(runId + "\u0000" + callId);
        }
    }

    private void remember(String runId, String callId, String context) {
        synchronized (contexts) {
            contexts.put(runId + "\u0000" + callId, context);
        }
    }

    /** A run ended: what it left here goes. */
    public void runEnded(String runId) {
        synchronized (contexts) {
            contexts.keySet().removeIf(key -> key.startsWith(runId + "\u0000"));
        }
    }

    private static Classified refused(ToolCall call, ToolDecl decl, String reason) {
        return new Classified(call, decl, decl.risk(), "agent", null, call.input(), null, reason);
    }

    static List<String> flags(Collection<Taint> taint) {
        List<String> out = new ArrayList<>();
        for (Taint t : Set.copyOf(taint)) {
            out.add(t.name());
        }
        out.sort(null);
        return out;
    }

    private static Risk riskOf(String wire) {
        for (Risk risk : Risk.values()) {
            if (risk.wireName().equals(wire)) {
                return risk;
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return value instanceof Map<?, ?> m ? (Map<String, Object>) m : null;
    }
}
