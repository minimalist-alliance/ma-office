package com.minimalistalliance.desk.deskd.agent;

import com.minimalistalliance.desk.deskd.desks.DeskMessaging;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import java.util.function.Function;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The client's {@code agent.desks.*} for messages between the member's desks (draft ADR "the Agent's tools and
 * approvals", §14; API.md §18, "Messages between the member's desks"), and what deskd does around the member's own calls
 * that make and take back grants. desk-agent keeps the halves' rows for the screens and the outbox; deskd keeps the
 * keys and its own record of the halves ({@link DeskMessaging}), and makes and opens every envelope.
 *
 * <ul>
 *   <li>{@code agent.desks.list} and {@code agent.desks.take}: relayed as reads. {@code take} gives what waits in
 *       desk-agent's outbox for one desk, envelopes deskd sealed already.
 *   <li>{@code agent.desks.deliver}: the office's envelope from another desk. deskd opens and checks it itself
 *       ({@link DeskMessaging#open}), and only then hands desk-agent what it said, as {@code desk.desks.deliver}, which no
 *       client can send. The client's params never reach desk-agent.
 *   <li>{@code agent.desks.done}: relayed; a refusal {@code revoked} from the other desk takes this desk's half too.
 *   <li>{@code agent.desks.answer}: the member allows an offer here (a session that may act), checked against deskd's
 *       own record first; once desk-agent has made its half active, deskd makes the accept.
 *   <li>Around the member's {@code agent.access.set}, {@code agent.desks.revoke} and {@code agent.delete}: the offers
 *       and revokes those call for ({@link #afterAccess}, {@link #afterRevoke}, {@link #afterDelete}).
 * </ul>
 * Envelopes deskd makes for desk-agent's outbox go as {@code desk.desks.queue}, which no client can send, on every
 * connection until desk-agent has them. Owner tokens only, never a guild member's, and never on a Guild Desk
 * ({@code forbidden}, {@code guild}).
 */
final class DeskMethods {

    private static final Logger log = LoggerFactory.getLogger(DeskMethods.class);

    static final String LIST = "agent.desks.list";
    static final String TAKE = "agent.desks.take";
    static final String DELIVER = "agent.desks.deliver";
    static final String DONE = "agent.desks.done";
    static final String ANSWER = "agent.desks.answer";
    /** deskd's own, to desk-agent: never a client's. */
    static final String QUEUE = "desk.desks.queue";
    static final String DELIVERED = "desk.desks.deliver";
    private static final Pattern GRANT_ID = Pattern.compile("dg-[a-z2-7]{20}");
    private static final Pattern AGENT_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    /** Refusals that are final: the office reports them in {@code done}. The rest it tries again. */
    private static final Set<String> CONFLICTS = Set.of("stale", "expired");
    private static final Set<String> BAD = Set.of("envelope");
    private static final Duration QUEUE_RETRY = Duration.ofSeconds(5);

    private final AgentLink link;
    private final DeskMessaging messaging;
    private final Duration wait;
    private final Supplier<AgeBand.Band> band;
    private final BooleanSupplier guildDesk;
    private final Function<String, String> names;
    private final AtomicBoolean pushing = new AtomicBoolean();
    private final AtomicBoolean again = new AtomicBoolean();

    DeskMethods(AgentLink link, DeskMessaging messaging, Duration wait, Supplier<AgeBand.Band> band,
            BooleanSupplier guildDesk, Function<String, String> names) {
        this.link = link;
        this.messaging = messaging;
        this.wait = wait;
        this.band = band;
        this.guildDesk = guildDesk;
        this.names = names;
    }

    void register(RpcDispatcher dispatcher) {
        Set<String> owner = Set.of(RpcPrincipal.OWNER);
        dispatcher.register(LIST, owner, (context, params) -> {
            requireOwner(context);
            return link.call(LIST, params, wait, context.principal().sessionId(), null, caller(context));
        });
        dispatcher.register(TAKE, owner, (context, params) -> {
            requireOwner(context);
            return link.call(TAKE, params, wait, context.principal().sessionId(), null, caller(context));
        });
        dispatcher.registerMutation(DELIVER, owner, this::deliver);
        dispatcher.registerMutation(DONE, owner, this::done);
        dispatcher.registerMutation(ANSWER, owner, this::answer);
    }

    private static Map<String, Object> caller(RpcContext context) {
        return context.principal().caller().toJson();
    }

    /** The owner, an adult, on a desk that isn't a Guild Desk. */
    private void requireOwner(RpcContext context) throws RpcException {
        RpcPrincipal principal = context.principal();
        if (principal.isGuildMember() || !AgentMethods.OWNER.equals(principal.scope())) {
            throw AgentMethods.forbidden();
        }
        AgentMethods.requireBand(band.get());
        if (guildDesk.getAsBoolean()) {
            throw new RpcException(RpcException.FORBIDDEN, "Not on a Guild Desk", Map.of("reason", "guild"));
        }
        if (!link.isConnected()) {
            throw new RpcException(RpcException.UNAVAILABLE, "desk-agent isn't running, so nothing changed",
                    Map.of("reason", "unavailable"));
        }
    }

    /** A session that may act: the owner's, with input. */
    private void requireInput(RpcContext context) throws RpcException {
        if (!context.principal().input()) {
            throw AgentMethods.forbidden();
        }
    }

    private AgentLink.Gate gate(RpcContext context, boolean input) {
        return () -> {
            context.beginEffect();
            requireOwner(context);
            if (input) {
                requireInput(context);
            }
        };
    }

    // ---------------------------------------------------------------- the carrier

    private Object deliver(RpcContext context, Map<String, Object> params) throws Exception {
        requireOwner(context);
        requireInput(context);
        if (params.size() != 1 || !(params.get("envelope") instanceof Map<?, ?> envelope)) {
            throw refused("envelope");
        }
        Map<String, Object> opened;
        try {
            opened = messaging.open(envelope);
        } catch (DeskMessaging.Refused e) {
            throw refused(e.reason());
        }
        // deskd's own view of the envelope, checked: the client's params never go to desk-agent.
        try {
            Object answer = link.call(DELIVERED, Map.of("opened", opened), wait, context.principal().sessionId(),
                    gate(context, true), null);
            // An answer the waiting desk_message call took: that run's source, for To-do (kind desk).
            if ("answer".equals(opened.get("kind")) && answer instanceof Map<?, ?> a
                    && Boolean.TRUE.equals(a.get("taken"))) {
                messaging.sources().answerTaken(opened);
            }
            return answer;
        } catch (RpcException e) {
            // desk-agent's own rows say this desk's half is revoked: deskd's half goes too. Only takes away.
            Map<String, Object> d = e.details();
            if (d != null && "revoked".equals(d.get("reason"))
                    && opened.get("grantId") instanceof String grantId && GRANT_ID.matcher(grantId).matches()) {
                messaging.peerRevoked(grantId);
            }
            throw e;
        }
    }

    private Object done(RpcContext context, Map<String, Object> params) throws Exception {
        requireOwner(context);
        Object answer = link.call(DONE, params, wait, context.principal().sessionId(), gate(context, false),
                caller(context));
        // The other desk refused an envelope as revoked: its half is, and so is this one. Only ever takes away.
        if (answer instanceof Map<?, ?> a && a.get("revoked") instanceof List<?> revoked) {
            for (Object grantId : revoked) {
                if (grantId instanceof String g && GRANT_ID.matcher(g).matches()) {
                    messaging.revoke(g);
                }
            }
            pushOwed();
        }
        return answer;
    }

    // ---------------------------------------------------------------- the member's choices

    private Object answer(RpcContext context, Map<String, Object> params) throws Exception {
        requireOwner(context);
        requireInput(context);
        String grantId = params.get("grantId") instanceof String g && GRANT_ID.matcher(g).matches() ? g : null;
        if (grantId == null) {
            throw new RpcException(RpcException.BAD_REQUEST, "No such grant", Map.of("detail", "grantId"));
        }
        boolean allow = Boolean.TRUE.equals(params.get("allow"));
        String agentId = params.get("agentId") instanceof String a && AGENT_ID.matcher(a).matches() ? a : null;
        if (allow && (agentId == null || agentId.startsWith("gm-"))) {
            throw new RpcException(RpcException.BAD_REQUEST, "Choose the agent that answers", Map.of("detail", "agentId"));
        }
        var half = messaging.grants().half(grantId);
        if (half == null || half.role() != com.minimalistalliance.desk.deskd.desks.DeskGrants.Role.ANSWER
                || half.revoked()) {
            throw new RpcException(RpcException.NOT_FOUND, "No such offer", Map.of("detail", "grant"));
        }
        Object answer = link.call(ANSWER, params, wait, context.principal().sessionId(), gate(context, true),
                caller(context));
        try {
            if (allow) {
                messaging.accept(grantId, agentId, names.apply(agentId));
            } else {
                messaging.decline(grantId);
            }
        } catch (DeskMessaging.Refused e) {
            log.warn("an allowed offer's accept wasn't made: {}", e.reason());
        }
        pushOwed();
        return answer;
    }

    /**
     * Before desk-agent hears the member's {@code agent.access.set}: each desk the member switched off loses deskd's send
     * half for this agent first, with its revoke. Only takes away, so a refusal after it leaves nothing wider.
     */
    void beforeAccess(String agentId, Map<String, Object> params) {
        if (agentId == null) {
            return;
        }
        Set<String> off = switched(params, false);
        boolean changed = false;
        for (var half : messaging.grants().liveOf(agentId)) {
            if (half.role() == com.minimalistalliance.desk.deskd.desks.DeskGrants.Role.SEND
                    && off.contains(half.peerDeskId())) {
                changed |= messaging.revoke(half.grantId()) != null;
            }
        }
        if (changed) {
            pushOwed();
        }
    }

    /**
     * After desk-agent answered the member's {@code agent.access.set}: a send half it made that deskd doesn't hold is
     * recorded {@code offered}, with its offer, only for a desk the member switched on in this call (the member's params
     * cut to desk-agent's answer: desk-agent's word is never enough); each deskd holds live that desk-agent no longer
     * lists is revoked.
     */
    void afterAccess(String agentId, Map<String, Object> params, Object answer) {
        if (agentId == null || !(answer instanceof Map<?, ?> a) || !(a.get("access") instanceof Map<?, ?> access)
                || !(access.get("desks") instanceof List<?> halves)) {
            return;
        }
        Set<String> on = switched(params, true);
        List<String> live = new ArrayList<>();
        for (Object item : halves) {
            if (item instanceof Map<?, ?> h && h.get("grantId") instanceof String grantId
                    && GRANT_ID.matcher(grantId).matches() && h.get("toDeskId") instanceof String toDesk
                    && agentId.equals(h.get("agentId"))) {
                live.add(grantId);
                if (messaging.grants().half(grantId) == null && "offered".equals(h.get("state"))
                        && on.contains(toDesk)) {
                    try {
                        messaging.offer(grantId, agentId, names.apply(agentId), toDesk);
                    } catch (DeskMessaging.Refused e) {
                        log.warn("a grant's offer wasn't made: {}", e.reason());
                    }
                }
            }
        }
        for (var half : messaging.grants().liveOf(agentId)) {
            if (half.role() == com.minimalistalliance.desk.deskd.desks.DeskGrants.Role.SEND
                    && !live.contains(half.grantId())) {
                messaging.revoke(half.grantId());
            }
        }
        pushOwed();
    }

    /** The desks the member's own {@code agent.access.set} params switched on (or off). */
    private static Set<String> switched(Map<String, Object> params, boolean value) {
        Set<String> out = new java.util.HashSet<>();
        if (params != null && params.get("desks") instanceof List<?> desks) {
            for (Object item : desks) {
                if (item instanceof Map<?, ?> desk && desk.get("deskId") instanceof String deskId
                        && Boolean.valueOf(value).equals(desk.get("on"))) {
                    out.add(deskId);
                }
            }
        }
        return out;
    }

    /**
     * The member's {@code agent.desks.revoke}: deskd's half goes before desk-agent hears (it only takes away), with its
     * revoke; and again after, which is then nothing.
     */
    void afterRevoke(Map<String, Object> params) {
        if (params.get("grantId") instanceof String grantId && GRANT_ID.matcher(grantId).matches()) {
            messaging.revoke(grantId);
            pushOwed();
        }
    }

    /** After the agent was deleted: every half of its revoked, each with its revoke. */
    void afterDelete(String agentId) {
        if (agentId != null && !messaging.agentGone(agentId).isEmpty()) {
            pushOwed();
        }
    }

    // ---------------------------------------------------------------- the outbox

    /** Hands desk-agent what deskd made for its outbox, on a thread of its own, until it has it all. */
    void pushOwed() {
        if (messaging.grants().owed().isEmpty()) {
            return;
        }
        again.set(true);
        if (!pushing.compareAndSet(false, true)) {
            return;
        }
        Thread.ofVirtual().name("agent-desks-queue").start(() -> {
            try {
                while (again.getAndSet(false) || !messaging.grants().owed().isEmpty()) {
                    if (!link.isConnected()) {
                        return; // the next connection pushes again
                    }
                    try {
                        messaging.queued(link.call(QUEUE, messaging.queueParams(), wait));
                    } catch (RpcException e) {
                        if (RpcException.NOT_FOUND.equals(e.code())) {
                            return; // an older desk-agent: the next connection tries again
                        }
                        Thread.sleep(QUEUE_RETRY.toMillis());
                    }
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                pushing.set(false);
                if (again.get() && link.isConnected() && !messaging.grants().owed().isEmpty()) {
                    pushOwed();
                }
            }
        });
    }

    /** The link came up: what's owed goes again. */
    void connected() {
        pushOwed();
    }

    /** A refusal of an envelope, in API.md §18's codes: final ones the office reports in {@code done}. */
    static RpcException refused(String reason) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("reason", reason);
        if (BAD.contains(reason)) {
            return new RpcException(RpcException.BAD_REQUEST, "Not an envelope", details);
        }
        if (CONFLICTS.contains(reason)) {
            return new RpcException(RpcException.CONFLICT, "Refused", details);
        }
        if ("too_large".equals(reason)) {
            return new RpcException(RpcException.TOO_LARGE, "Too large", details);
        }
        if ("unavailable".equals(reason)) {
            return new RpcException(RpcException.UNAVAILABLE, "Not now", details);
        }
        return new RpcException(RpcException.FORBIDDEN, "Refused", details);
    }
}
