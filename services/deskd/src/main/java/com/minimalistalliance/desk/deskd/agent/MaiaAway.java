package com.minimalistalliance.desk.deskd.agent;

import com.minimalistalliance.desk.deskd.desks.DeskMessaging;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Maia while the member is away, deskd's part (Maia Mode Phase 2; API.md §23 "While the member is away"; ma-platform
 * contract agent.md "Maia while you're away", ADR 0141). With no office open nothing carries the sealed envelopes between
 * the member's desks and nothing keeps her desk up, so, only while the Platform's heartbeat reply says {@code maia.away}
 * (a listed member, the kill switch on, the member's own switch on):
 *
 * <ul>
 *   <li><b>The carrier</b>: what desk-agent's outbox has held for 30 s (the office carries anything sooner) goes to the
 *       Platform as it is ({@code POST /v1/agent/maia send}); what waits there for this desk is opened and checked here, as
 *       an envelope the office delivers is ({@link DeskMessaging#open}), handed to desk-agent, and acked with its outcome;
 *       the outcomes of what this desk sent come back and go to desk-agent's {@code done}. Envelopes are never read by
 *       the Platform, and a message never wakes a desk: only her brief asks to ({@code wake}), and the Platform holds who
 *       and how often.</li>
 *   <li><b>Her hold and her check-in</b>: the heartbeat's {@code maia} says whether she has work in flight (a hold at most
 *       10 minutes ahead, renewed each beat; the Platform clamps it and counts the member's hours) and her next check-in
 *       ({@code wakeAt}), from desk-agent's {@code agent.state} {@code maiaAway}.</li>
 *   <li><b>The bell</b>: when her questions or her finishing go up while the member is away, or approvals wait here, once
 *       each ({@code POST /v1/agent/maia notify}). Fixed kinds, never content; the Platform skips it while the member is
 *       in the office.</li>
 * </ul>
 * Nothing here runs on a Guild Desk, and none of it touches what the office does when it's open.
 */
public final class MaiaAway implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(MaiaAway.class);

    /** How long the office has to carry an envelope before deskd does. */
    public static final Duration OFFICE_FIRST = Duration.ofSeconds(30);
    /** A post the Platform has, re-sent only after this long with no outcome. */
    static final Duration REPOST_AFTER = Duration.ofMinutes(10);
    static final Duration HOLD_AHEAD = Duration.ofMinutes(10);
    static final Duration CALL_WAIT = Duration.ofSeconds(30);
    private static final Pattern ENV_ID = Pattern.compile("env-[a-z2-7]{26}");
    private static final Pattern GRANT_ID = Pattern.compile("dg-[a-z2-7]{20}");
    private static final Pattern DESK_ID = Pattern.compile("d-[a-z2-7]{12}");
    private static final Set<String> FINAL = Set.of(RpcException.BAD_REQUEST, RpcException.FORBIDDEN, "conflict",
            RpcException.TOO_LARGE);

    /** The Platform's routes, as the desk role (AgentClient). */
    public interface Platform {
        Map<String, Object> post(Map<String, Object> body) throws Exception;

        Map<String, Object> collect() throws Exception;
    }

    /** desk-agent, through deskd's link: deskd-only methods, no caller. */
    public interface Agent {
        Object call(String method, Map<String, Object> params) throws Exception;

        boolean connected();
    }

    private final Platform platform;
    private final Agent agent;
    private final DeskMessaging messaging;
    private final Clock clock;
    private final java.util.function.BooleanSupplier guildDesk;
    private final java.util.function.Supplier<String> deskId;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition wake = lock.newCondition();
    private volatile boolean closed;
    private volatile Thread thread;

    /** From the latest heartbeat reply. */
    private volatile boolean away;
    private volatile int pollSeconds = 60;
    /** From desk-agent's latest agent.state. */
    private volatile Map<String, Object> state = Map.of();
    private volatile int approvalsWaiting;
    private int seenAsks;
    private int seenDone;
    private int seenApprovals;
    private int seenReach;
    /** Where the counts came from last pass: {@code ring} or Phase 2's own; a change (or deskd's first look at
     *  {@code ring}, whose counts run for desk-agent's life) only takes the new counts as seen. */
    private String seenFrom;
    /** The member just left: the shield's own count so far is taken as seen at the next pass. */
    private volatile boolean seenReachAtAway;
    /**
     * The bell's kinds the Platform takes: Phase 2's three, unless the heartbeat reply's {@code maia.notifyKinds} lists
     * more. The shield's own kind ({@code reach}: "Something needs you") rings only once the Platform says it takes it.
     */
    static final Set<String> PHASE2_KINDS = Set.of("question", "approval", "done");
    private volatile Set<String> notifyKinds = PHASE2_KINDS;
    private final Map<String, Long> posted = new ConcurrentHashMap<>();
    private volatile Runnable afterRevoke = () -> {};

    /** Opens and checks an envelope as the office's deliver does ({@link DeskMessaging#open}); a test's own. */
    interface Opener {
        Map<String, Object> open(Object envelope) throws DeskMessaging.Refused;
    }

    private final Opener opener;

    public MaiaAway(Platform platform, Agent agent, DeskMessaging messaging, Clock clock,
            java.util.function.BooleanSupplier guildDesk, java.util.function.Supplier<String> deskId) {
        this(platform, agent, messaging, messaging::open, clock, guildDesk, deskId);
    }

    MaiaAway(Platform platform, Agent agent, DeskMessaging messaging, Opener opener, Clock clock,
            java.util.function.BooleanSupplier guildDesk, java.util.function.Supplier<String> deskId) {
        this.opener = opener;
        this.platform = platform;
        this.agent = agent;
        this.messaging = messaging;
        this.clock = clock;
        this.guildDesk = guildDesk;
        this.deskId = deskId;
    }

    /** What to run after a grant here was revoked by the other desk's refusal (deskd's owed envelopes go out). */
    public void afterRevoke(Runnable r) {
        this.afterRevoke = r == null ? () -> {} : r;
    }

    public void start() {
        thread = Thread.ofVirtual().name("maia-away").start(this::loop);
    }

    @Override
    public void close() {
        closed = true;
        signal();
        Thread t = thread;
        if (t != null) {
            t.interrupt();
        }
    }

    private void signal() {
        lock.lock();
        try {
            wake.signalAll();
        } finally {
            lock.unlock();
        }
    }

    public boolean away() {
        return away;
    }

    // ---------------------------------------------------------------- the heartbeat

    /** The heartbeat's {@code maia}, or null to send none (nothing of hers here, or a Guild Desk). */
    public Map<String, Object> heartbeatBlock() {
        Map<String, Object> s = state;
        if (guildDesk.getAsBoolean() || s.isEmpty()) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        Instant now = clock.instant().truncatedTo(ChronoUnit.SECONDS);
        if (Boolean.TRUE.equals(s.get("inFlight"))) {
            out.put("holdUntil", now.plus(HOLD_AHEAD).toString());
        }
        if (s.get("wakeAt") instanceof Number at && at.longValue() > now.toEpochMilli()) {
            out.put("wakeAt", Instant.ofEpochMilli(at.longValue()).truncatedTo(ChronoUnit.SECONDS).toString());
        }
        if (Boolean.TRUE.equals(s.get("on"))) {
            out.put("home", true);
        }
        return out.isEmpty() ? null : out;
    }

    /** What waits on the Platform for this desk (the reply's {@code waiting}); unknown counts as some. */
    private volatile int waitingThere = 1;
    private volatile String told = null;
    private volatile long toldAt;

    /** The heartbeat reply's {@code maia}: absent or {@code away: false} turns the carrier off. */
    public void onReply(Map<String, Object> maia) {
        boolean was = away;
        away = maia != null && Boolean.TRUE.equals(maia.get("away")) && !guildDesk.getAsBoolean();
        if (maia != null && maia.get("pollSeconds") instanceof Number n) {
            pollSeconds = (int) Math.max(15, Math.min(600, n.longValue()));
        }
        waitingThere = maia != null && maia.get("waiting") instanceof Number w ? Math.max(0, w.intValue()) : 1;
        if (maia == null || !(maia.get("notifyKinds") instanceof List<?>)) {
            notifyKinds = PHASE2_KINDS; // A reply that doesn't say is Phase 2's three (Security's SF2-L2).
        } else if (maia.get("notifyKinds") instanceof List<?> kinds) {
            java.util.Set<String> k = new java.util.HashSet<>();
            for (Object o : kinds) {
                if (o instanceof String x && x.matches("[a-z_]{1,20}") && k.size() < 10) {
                    k.add(x);
                }
            }
            notifyKinds = Set.copyOf(k);
        }
        // desk-agent hears whether she may work while the member is away, and whether today's hours are used (MA-M1):
        // on a change, and again every 10 minutes (a desk-agent restart forgets it, and then waits).
        String hold = maia != null && maia.get("hold") instanceof String h ? h : "off";
        String word = away + "/" + hold;
        long now = clock.millis();
        if (!word.equals(told) || now - toldAt > 600_000) {
            told = word;
            toldAt = now;
            boolean a = away;
            Thread.ofVirtual().name("maia-away-tell").start(() -> {
                try {
                    agent.call("desk.maia.away", Map.of("away", a, "hold", hold));
                } catch (Exception e) {
                    told = null; // Said again at the next reply.
                }
            });
        }
        if (away && waitingThere > 0) {
            signal();
        }
        if (away && !was) {
            // What the shield counted while the member was still at the office (idle there) isn't rung now they've left.
            seenReachAtAway = true;
            log.info("maia away: carrying on");
            signal();
        } else if (!away && was) {
            log.info("maia away: off");
        }
    }

    /** desk-agent's latest {@code agent.state}: her block, and approvals waiting here. Must not block. */
    public void onAgentState(Map<String, Object> data) {
        state = data.get("maiaAway") instanceof Map<?, ?> m ? cast(m) : Map.of();
        int waiting = 0;
        if (data.get("agents") instanceof List<?> agents) {
            for (Object a : agents) {
                if (a instanceof Map<?, ?> map && map.get("approvalsPending") instanceof Number n) {
                    waiting += Math.max(0, n.intValue());
                }
            }
        }
        approvalsWaiting = waiting;
        // Only a rise the bell rings for brings a pass sooner; everything else waits for the next poll (MA-L2).
        int[] c = counts(state);
        if (c[0] > seenAsks || c[1] > seenDone || waiting > seenApprovals || c[2] > seenReach) {
            signal();
        }
    }

    /**
     * Her questions, her finishing and the shield's own: {@code [question, done, reach]}. While the shield is on
     * desk-agent sends {@code ring} (API.md §23 "What reaches the member": the shield's quiet hours and day's bells), and
     * its counts replace Phase 2's {@code asks} and {@code done}; without it (an older desk-agent, the member's "Show
     * everything as it comes") Phase 2's counts ring as before.
     */
    static int[] counts(Map<String, Object> s) {
        if (s.get("ring") instanceof Map<?, ?> r) {
            return new int[] {r.get("question") instanceof Number n ? n.intValue() : 0,
                r.get("done") instanceof Number n ? n.intValue() : 0, r.get("reach") instanceof Number n ? n.intValue() : 0};
        }
        return new int[] {s.get("asks") instanceof Number n ? n.intValue() : 0,
            s.get("done") instanceof Number n ? n.intValue() : 0, 0};
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cast(Map<?, ?> m) {
        return (Map<String, Object>) m;
    }

    // ---------------------------------------------------------------- the loop

    private void loop() {
        while (!closed) {
            try {
                if (away && agent.connected()) {
                    pass();
                }
            } catch (InterruptedException e) {
                return;
            } catch (RuntimeException e) {
                log.warn("maia away: a pass failed ({})", e.getClass().getSimpleName());
            }
            lock.lock();
            try {
                if (closed) {
                    return;
                }
                wake.await(away ? pollSeconds : 60, java.util.concurrent.TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                return;
            } finally {
                lock.unlock();
            }
        }
    }

    /** One pass: the bell, what goes out, what came in, and what became of what went out. */
    public void pass() throws InterruptedException {
        if (!away || guildDesk.getAsBoolean()) {
            return;
        }
        bell();
        try {
            send();
        } catch (InterruptedException e) {
            throw e;
        } catch (Exception e) {
            log.info("maia away: sending stopped ({})", e.getClass().getSimpleName());
        }
        if (waitingThere <= 0) {
            return; // Nothing waits there for this desk (the last heartbeat reply said): no call.
        }
        try {
            receive();
        } catch (InterruptedException e) {
            throw e;
        } catch (Exception e) {
            log.info("maia away: collecting stopped ({})", e.getClass().getSimpleName());
        }
    }

    private void bell() throws InterruptedException {
        Map<String, Object> s = state;
        int[] c = counts(s);
        int asks = c[0];
        int done = c[1];
        int reach = c[2];
        int approvals = approvalsWaiting;
        boolean herAway = !Boolean.FALSE.equals(s.get("away"));
        String from = s.get("ring") instanceof Map<?, ?> ? "ring" : "phase2";
        if (!from.equals(seenFrom) && (seenFrom != null || "ring".equals(from))) {
            seenAsks = asks;
            seenDone = done;
            seenReach = reach;
        }
        seenFrom = from;
        if (seenReachAtAway) {
            seenReachAtAway = false;
            seenReach = reach;
        }
        if (asks > seenAsks && herAway) {
            notify("question");
        }
        if (done > seenDone && herAway) {
            notify("done");
        }
        if (approvals > seenApprovals) {
            notify("approval");
        }
        // The shield's own: an item it holds at interrupt level (a let-through match, a code-rule Now), fixed words.
        if (reach > seenReach && notifyKinds.contains("reach")) {
            notify("reach");
        }
        seenAsks = asks;
        seenDone = done;
        seenApprovals = approvals;
        seenReach = reach;
    }

    private void notify(String kind) throws InterruptedException {
        try {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("action", "notify");
            body.put("kind", kind);
            platform.post(body);
        } catch (InterruptedException e) {
            throw e;
        } catch (Exception e) {
            log.info("maia away: the bell didn't ring ({})", e.getClass().getSimpleName());
        }
    }

    /** What desk-agent's outbox held for 30 s, to the Platform, by desk; a post it already has isn't sent again soon. */
    void send() throws Exception {
        Object snap = agent.call("desk.desks.outbox", Map.of());
        if (!(snap instanceof Map<?, ?> m) || !(m.get("pending") instanceof List<?> pending)) {
            return;
        }
        long now = clock.millis();
        posted.values().removeIf(at -> now - at > REPOST_AFTER.toMillis());
        for (Object p : pending) {
            if (!(p instanceof Map<?, ?> row) || !(row.get("toDeskId") instanceof String to) || !DESK_ID.matcher(to).matches()
                    || !(row.get("oldestAt") instanceof Number oldest)
                    || now - oldest.longValue() < OFFICE_FIRST.toMillis()) {
                continue;
            }
            Map<String, Object> params = new LinkedHashMap<>();
            params.put("toDeskId", to);
            params.put("limit", 20);
            params.put("olderThanMs", OFFICE_FIRST.toMillis());
            Object taken = agent.call("desk.desks.take", params);
            if (!(taken instanceof Map<?, ?> t) || !(t.get("envelopes") instanceof List<?> list)) {
                continue;
            }
            List<Map<String, Object>> out = new ArrayList<>();
            boolean wakeIt = false;
            for (Object e : list) {
                if (e instanceof Map<?, ?> env && env.get("id") instanceof String id && ENV_ID.matcher(id).matches()
                        && env.get("envelope") instanceof Map<?, ?> sealed && !posted.containsKey(id)) {
                    Map<String, Object> one = new LinkedHashMap<>();
                    one.put("id", id);
                    one.put("envelope", sealed);
                    out.add(one);
                    wakeIt |= Boolean.TRUE.equals(env.get("wake"));
                }
            }
            if (out.isEmpty()) {
                continue;
            }
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("action", "send");
            body.put("toDeskId", to);
            body.put("envelopes", out);
            if (wakeIt) {
                body.put("wake", true);
            }
            platform.post(body);
            for (Map<String, Object> one : out) {
                posted.put((String) one.get("id"), now);
            }
        }
    }

    /** What waits for this desk, opened and handed to desk-agent in order; then what became of what this desk sent. */
    void receive() throws Exception {
        Map<String, Object> got = platform.collect();
        List<Map<String, Object>> outcomes = new ArrayList<>();
        if (got.get("envelopes") instanceof List<?> envelopes) {
            for (Object e : envelopes) {
                if (!(e instanceof Map<?, ?> env) || !(env.get("id") instanceof String id) || !ENV_ID.matcher(id).matches()) {
                    continue;
                }
                Map<String, Object> outcome = deliver(id, env.get("envelope"));
                if (outcome == null) {
                    break; // Not now (desk-agent busy or away): this one and the rest wait, in order.
                }
                outcomes.add(outcome);
            }
        }
        List<String> resultIds = new ArrayList<>();
        if (got.get("results") instanceof List<?> results && !results.isEmpty()) {
            List<Map<String, Object>> done = new ArrayList<>();
            for (Object r : results) {
                if (r instanceof Map<?, ?> res && res.get("id") instanceof String id && ENV_ID.matcher(id).matches()
                        && res.get("outcome") instanceof String o) {
                    Map<String, Object> one = new LinkedHashMap<>();
                    one.put("id", id);
                    one.put("outcome", o);
                    if (res.get("reason") instanceof String reason) {
                        one.put("reason", reason);
                    }
                    done.add(one);
                    resultIds.add(id);
                    posted.remove(id);
                }
            }
            if (!done.isEmpty()) {
                Object answer = agent.call("desk.desks.done", Map.of("results", done));
                if (answer instanceof Map<?, ?> a && a.get("revoked") instanceof List<?> revoked && !revoked.isEmpty()) {
                    for (Object g : revoked) {
                        if (g instanceof String grant && GRANT_ID.matcher(grant).matches()) {
                            messaging.revoke(grant);
                        }
                    }
                    afterRevoke.run();
                }
            }
        }
        if (!outcomes.isEmpty() || !resultIds.isEmpty()) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("action", "ack");
            body.put("envelopes", outcomes);
            body.put("results", resultIds);
            platform.post(body);
        }
    }

    /** One envelope in: {@code {id, outcome, reason?}}, or null to stop here and try again later. */
    Map<String, Object> deliver(String id, Object envelope) throws InterruptedException {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id);
        Map<String, Object> opened;
        try {
            opened = opener.open(envelope);
        } catch (DeskMessaging.Refused e) {
            out.put("outcome", "refused");
            out.put("reason", e.reason());
            return out;
        }
        try {
            Object answer = agent.call("desk.desks.deliver", Map.of("opened", opened));
            if ("answer".equals(opened.get("kind")) && answer instanceof Map<?, ?> a && Boolean.TRUE.equals(a.get("taken"))) {
                messaging.sources().answerTaken(opened);
            }
            out.put("outcome", answer instanceof Map<?, ?> a && "duplicate".equals(a.get("outcome")) ? "duplicate"
                    : "delivered");
            return out;
        } catch (RpcException e) {
            Map<String, Object> d = e.details();
            String reason = d != null && d.get("reason") instanceof String r ? r : null;
            if ("revoked".equals(reason) && opened.get("grantId") instanceof String grantId
                    && GRANT_ID.matcher(grantId).matches()) {
                messaging.peerRevoked(grantId);
            }
            if (FINAL.contains(e.code()) && reason != null) {
                out.put("outcome", "refused");
                out.put("reason", reason);
                return out;
            }
            return null;
        } catch (InterruptedException e) {
            throw e;
        } catch (Exception e) {
            return null;
        }
    }
}
