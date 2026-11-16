package com.minimalistalliance.desk.agent.harness;

import com.minimalistalliance.desk.agent.approval.Approvals;
import com.minimalistalliance.desk.agent.tool.DeskLink;
import com.minimalistalliance.desk.agent.tool.ToolDecl;
import com.minimalistalliance.desk.agent.tool.ToolRegistry;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;

/**
 * deskd, as the draft ADR and {@code API.md} section 18 say it behaves, counted: the harness's stand-in for the tools
 * deskd runs (W7, Maia Mode Phase 0). It is one deskd process that outlives desk-agent's: each desk-agent start
 * {@link #attach}es its own link, and a kill {@link #cut}s that link. {@link #restart} is deskd's own restart.
 *
 * <p>What it keeps, as deskd does: the member's relayed yeses ({@link #relay}; single use, the hash recomputed over the
 * arguments it received), its own record of the auto-approve switches ({@link #switchOn}), and each keyed call's reply
 * by agent and key for 10 minutes in RAM ({@code retry: true} for a key it doesn't hold is {@code key_unknown}). A
 * {@link #restart} loses all three, as deskd's RAM does. What it counts: every call it actually ran ({@link #executions}),
 * which is how the fault matrix proves 0 double executions and 0 silent losses.
 *
 * <p>Where a fault can strike, it can hold a call ({@link #holdAt}): at the look, when the frame arrives, while the call
 * runs (before it takes effect), and after it took effect (before the answer goes back). A held call does what a real
 * deskd would after the fault: a frame that never arrived ({@link #dropHeld}) never runs; a call running when deskd died
 * never takes effect; a call running when desk-agent died finishes, and its answer is kept by its key.
 */
public final class CountingDeskd {

    /** Where a call can be held. */
    public enum Point {
        /** deskd's look at a call, before any card. */
        LOOK,
        /** The run-phase frame has reached deskd; nothing checked or done yet. */
        RECEIVED,
        /** Every check passed; the call is running and hasn't taken effect. */
        RUNNING,
        /** The call took effect; its answer hasn't gone back. */
        RAN
    }

    /** One call deskd actually ran. */
    public record Exec(long seq, String tool, String agentId, String runId, String approvalId, String auto,
            String autoApprovalId, String key, Map<String, Object> args) {}

    /** How the tool's own store answers: as it should, gone (a missing mount), or full. */
    public enum Store { OK, AWAY, FULL }

    private static final long KEEP_MS = Duration.ofMinutes(10).toMillis();
    private static final Set<String> READ_OR_OWN = Set.of("read", "own");
    private static final ToolRegistry REGISTRY = new ToolRegistry();

    /**
     * Whether deskd keeps a call's reply by its key, as {@code ToolHost.kept} does: every tool but a {@code SAFE} one, and
     * a {@code SAFE} one whose class asks.
     */
    private static boolean keeps(String tool, String risk) {
        ToolDecl decl = REGISTRY.decl(tool);
        if (decl != null && decl.restart() != com.minimalistalliance.desk.agent.tool.Restart.SAFE) {
            return true;
        }
        return !READ_OR_OWN.contains(risk);
    }

    private final ToolRegistry registry = new ToolRegistry();
    private final List<Exec> executions = new CopyOnWriteArrayList<>();
    private final AtomicLong seq = new AtomicLong();
    /** approvalId → the hash the member's yes was for, and whether it was spent. */
    private final Map<String, Ticket> tickets = new ConcurrentHashMap<>();
    private final Set<String> switches = ConcurrentHashMap.newKeySet();
    private final Map<String, Kept> kept = new ConcurrentHashMap<>();
    private final AtomicInteger generation = new AtomicInteger();
    private final AtomicInteger links = new AtomicInteger();
    /** The class deskd's look gives a call of this tool (its rise: a submit is send), or null for the declaration's. */
    public final Map<String, String> lookRisk = new ConcurrentHashMap<>();
    /** What a tool's run answers, as {@code r.content}; by default a short word. */
    public final Map<String, Function<Map<String, Object>, Object>> results = new ConcurrentHashMap<>();
    /** What deskd's look refuses a call for before any card ({@code sensitive}, {@code path}, ...), or null. */
    public final Map<String, Function<Map<String, Object>, String>> lookRefusal = new ConcurrentHashMap<>();
    /** What deskd's look says the call acts on (a click's label and site), which the card's title is filled from. */
    public final Map<String, Function<Map<String, Object>, Map<String, Object>>> lookTarget = new ConcurrentHashMap<>();
    public volatile Store store = Store.OK;
    /** Broken on purpose, for the harness's own self-test: runs a retried key as a new call. */
    public volatile boolean forgetKeys;
    /** Broken on purpose: after the call took effect, answers that it failed. */
    public volatile boolean lieAfterRun;
    /** Broken on purpose: answers a call as done without running it. */
    public volatile boolean skipRun;
    private volatile Hold hold;
    /** The clock deskd keeps its 10 minutes by. */
    public volatile java.util.function.LongSupplier clock = System::currentTimeMillis;
    /** Every frame any link sent, in order: what desk-agent asked of deskd. */
    public final List<Map<String, Object>> frames = new CopyOnWriteArrayList<>();

    private record Ticket(String sha256, String agentId, boolean[] used) {}

    private static final class Kept {
        final long at;
        final CountDownLatch done = new CountDownLatch(1);
        final String fingerprint;
        volatile DeskLink.Reply reply;

        Kept(long at, String fingerprint) {
            this.at = at;
            this.fingerprint = fingerprint;
        }
    }

    private static final class Hold {
        final Point point;
        final String tool;
        final CountDownLatch reached = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);
        volatile boolean drop;
        volatile Link link;

        Hold(Point point, String tool) {
            this.point = point;
            this.tool = tool;
        }
    }

    // ---------------------------------------------------------------- the harness's controls

    /** A new desk-agent start's link to this deskd. */
    public Link attach() {
        return new Link(links.incrementAndGet());
    }

    /** desk-agent died: its link is gone. What it sent and deskd is running finishes; nothing new arrives. */
    public void cut(Link link) {
        link.alive = false;
    }

    /** deskd restarted: its tickets, its kept replies and its record of the switches' relayed calls are lost. */
    public void restart() {
        generation.incrementAndGet();
        tickets.clear();
        kept.clear();
    }

    /** The member's yes, relayed from their session: deskd's ticket for it. */
    public void relay(String approvalId, String sha256, String agentId) {
        tickets.put(approvalId, new Ticket(sha256, agentId, new boolean[1]));
    }

    /**
     * The member switched a group on for an agent ({@code agent.access.set}, relayed): deskd's own record. Unlike the
     * tickets, deskd keeps this on {@code /data/desk}, so a restart keeps it.
     */
    public void switchOn(String agentId, String group) {
        switches.add(agentId + ":" + group);
    }

    /** Holds the next call of {@code tool} that reaches {@code point} until {@link #release}. */
    public void holdAt(Point point, String tool) {
        hold = new Hold(point, tool);
    }

    /** Waits until the held call is there. */
    public boolean awaitHeld(Duration wait) throws InterruptedException {
        Hold h = hold;
        return h != null && h.reached.await(wait.toMillis(), TimeUnit.MILLISECONDS);
    }

    /** The held frame never reached deskd after all (the connection died with it in flight): it never runs. */
    public void dropHeld() {
        Hold h = hold;
        if (h != null) {
            h.drop = true;
        }
    }

    /** Lets the held call go on. */
    public void release() {
        Hold h = hold;
        hold = null;
        if (h != null) {
            h.release.countDown();
        }
    }

    public List<Exec> executions() {
        return List.copyOf(executions);
    }

    public List<Exec> executionsOf(String tool) {
        return executions.stream().filter(e -> e.tool().equals(tool)).toList();
    }

    // ---------------------------------------------------------------- one desk-agent start's link

    /** One desk-agent process's connection. */
    public final class Link implements DeskLink {
        final int id;
        volatile boolean alive = true;

        Link(int id) {
            this.id = id;
        }

        @Override
        public Set<String> offered() {
            if (!alive) {
                return Set.of();
            }
            List<String> all = new ArrayList<>();
            for (ToolDecl decl : registry.all()) {
                if (decl.host() == ToolDecl.Host.DESKD) {
                    all.add(decl.name());
                }
            }
            return Set.copyOf(all);
        }

        @Override
        public boolean keyed() {
            return alive;
        }

        @Override
        public Reply call(Map<String, Object> call, Duration wait) throws InterruptedException {
            if (!alive) {
                return Reply.unavailable();
            }
            frames.add(withoutNulls(call));
            Reply reply = handle(call, this);
            // An answer to a desk-agent that died goes nowhere.
            return alive ? reply : Reply.noAnswer();
        }
    }

    // ---------------------------------------------------------------- deskd's handling

    @SuppressWarnings("unchecked")
    private DeskLink.Reply handle(Map<String, Object> call, Link link) throws InterruptedException {
        int gen = generation.get();
        String tool = (String) call.get("tool");
        String agentId = (String) call.get("agentId");
        String runId = (String) call.get("runId");
        Map<String, Object> args = call.get("args") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
        List<String> taint = call.get("taint") instanceof List<?> l ? (List<String>) l : List.of();
        if ("run_end".equals(tool)) {
            return new DeskLink.Reply(true, Map.of(), null, null, taint);
        }
        ToolDecl decl = registry.decl(tool);
        if (decl == null || decl.host() != ToolDecl.Host.DESKD) {
            return refused("not_found", "tool", taint);
        }
        String risk = lookRisk.getOrDefault(tool, decl.risk().wireName());
        if ("look".equals(call.get("phase"))) {
            if (holding(Point.LOOK, tool, link) || generation.get() != gen) {
                return DeskLink.Reply.noAnswer();
            }
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("risk", lookRisk.get(tool));
            r.put("context", "agent");
            r.put("target", lookTarget.containsKey(tool) ? lookTarget.get(tool).apply(args) : Map.of());
            r.put("payload", payloadOf(tool, args));
            r.put("before", null);
            r.put("refusal", lookRefusal.containsKey(tool) ? lookRefusal.get(tool).apply(args) : null);
            return new DeskLink.Reply(true, r, null, null, taint);
        }
        // ---- the run: the frame is here
        if (holding(Point.RECEIVED, tool, link) || generation.get() != gen) {
            return DeskLink.Reply.noAnswer();
        }
        String key = call.get("key") instanceof String k ? k : null;
        boolean retry = Boolean.TRUE.equals(call.get("retry"));
        String keptAt = key == null ? null : agentId + "|" + key;
        String fingerprint = tool + "|" + Canon.json(args);
        if (keptAt != null) {
            Kept k = kept.get(keptAt);
            if (k != null && clock.getAsLong() - k.at > KEEP_MS) {
                kept.remove(keptAt, k);
                k = null;
            }
            if (k != null) {
                if (!k.fingerprint.equals(fingerprint)) {
                    return refused("bad_request", "key_mismatch", taint);
                }
                // The same key again: the first one's answer, waiting while it runs; nothing runs twice.
                if (!k.done.await(30, TimeUnit.SECONDS)) {
                    return DeskLink.Reply.noAnswer();
                }
                return k.reply;
            }
            if (retry && !forgetKeys) {
                return refused("conflict", "key_unknown", taint);
            }
        }
        boolean gated = !READ_OR_OWN.contains(risk);
        Map<String, Object> approval = call.get("approval") instanceof Map<?, ?> a ? (Map<String, Object>) a : null;
        String auto = call.get("auto") instanceof String g ? g : null;
        if (approval != null) {
            String id = String.valueOf(approval.get("approvalId"));
            Ticket t = tickets.get(id);
            String context = call.get("context") instanceof String c ? c : "agent";
            String computed = Approvals.hash(agentId, runId, tool, context, args);
            if (t == null || !t.agentId().equals(agentId)) {
                return refused("forbidden", "approval_unknown", taint);
            }
            synchronized (t) {
                if (t.used()[0]) {
                    return refused("forbidden", "approval_used", taint);
                }
                if (!t.sha256().equals(computed) || !computed.equals(approval.get("sha256"))) {
                    return refused("forbidden", "approval_mismatch", taint);
                }
                t.used()[0] = true;
            }
        } else if (auto != null) {
            if (!switches.contains(agentId + ":" + auto) || taint.contains("U")) {
                return refused("forbidden", "approval_unknown", taint);
            }
        } else if (gated) {
            return refused("forbidden", "approval_required", taint);
        }
        if (store == Store.AWAY) {
            return refused("unavailable", "store", taint);
        }
        if (store == Store.FULL && !"read".equals(risk)) {
            return refused("no_space", "no_space", taint);
        }
        Kept mine = null;
        if (keptAt != null && keeps(tool, risk)) {
            mine = new Kept(clock.getAsLong(), fingerprint);
            Kept raced = kept.putIfAbsent(keptAt, mine);
            if (raced != null) {
                if (!raced.done.await(30, TimeUnit.SECONDS)) {
                    return DeskLink.Reply.noAnswer();
                }
                return raced.reply;
            }
        }
        if (holding(Point.RUNNING, tool, link) || generation.get() != gen) {
            // deskd died before the call took effect, or the frame was lost: nothing happened.
            return DeskLink.Reply.noAnswer();
        }
        if (!skipRun) {
            executions.add(new Exec(seq.incrementAndGet(), tool, agentId, runId,
                    approval == null ? null : String.valueOf(approval.get("approvalId")), auto,
                    call.get("autoApprovalId") instanceof String s ? s : null, key, Map.copyOf(args)));
        }
        Object content = results.containsKey(tool) ? results.get(tool).apply(args) : "done";
        List<String> after = new ArrayList<>(taint);
        for (var t : decl.taints()) {
            if (!after.contains(t.name())) {
                after.add(t.name());
            }
        }
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("content", content);
        if (!decl.taints().isEmpty()) {
            r.put("taints", decl.taints().stream().map(Enum::name).sorted().toList());
        }
        DeskLink.Reply reply = lieAfterRun ? refused("internal", "internal", after)
                : new DeskLink.Reply(true, r, null, null, after);
        if (mine != null) {
            mine.reply = reply;
            mine.done.countDown();
        }
        if (holding(Point.RAN, tool, link) || generation.get() != gen) {
            // It happened; the answer was lost with deskd (or never went).
            return DeskLink.Reply.noAnswer();
        }
        return reply;
    }

    /** Whether this call was held here and must answer nothing: its frame was dropped, or deskd died meanwhile. */
    private boolean holding(Point point, String tool, Link link) throws InterruptedException {
        Hold h = hold;
        if (h == null || h.point != point || !h.tool.equals(tool) || h.reached.getCount() == 0) {
            return false;
        }
        h.link = link;
        h.reached.countDown();
        h.release.await(60, TimeUnit.SECONDS);
        return h.drop;
    }

    private static DeskLink.Reply refused(String code, String reason, List<String> taint) {
        return new DeskLink.Reply(false, null, code, reason, taint);
    }

    /** deskd's look normalizes a call's payload: a write's {@code replace} is always a boolean. */
    private static Map<String, Object> payloadOf(String tool, Map<String, Object> args) {
        Map<String, Object> p = new LinkedHashMap<>(args);
        if ("files_write".equals(tool) && !(p.get("replace") instanceof Boolean)) {
            p.put("replace", false);
        }
        return p;
    }

    private static Map<String, Object> withoutNulls(Map<String, Object> call) {
        Map<String, Object> out = new LinkedHashMap<>();
        call.forEach((k, v) -> {
            if (v != null) {
                out.put(k, v);
            }
        });
        return out;
    }

    /** Canonical JSON for a fingerprint: keys sorted, as {@code team/Canonical}. */
    static final class Canon {
        static String json(Object value) {
            return com.minimalistalliance.desk.agent.team.Canonical.json(value);
        }
    }
}
