package com.minimalistalliance.desk.agent.tool;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;

import com.minimalistalliance.desk.agent.approval.ApprovalPolicy;
import com.minimalistalliance.desk.agent.approval.Approvals;
import com.minimalistalliance.desk.agent.approval.LowRisk;
import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.store.RunCallStore;
import com.minimalistalliance.desk.agent.store.RunStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The durable runs' fault rig (W7's shape, in-process): one agent's run on a real {@code AgentService} on real SQLite,
 * a model scripted by step, and a counting deskd that keeps each call's reply by its key, checks tickets once, and can
 * restart (its keys and tickets lost). A fault is a kill (the files close under the run and its thread dies where it
 * is, never reaching deskd again), a pause (SIGTERM's {@code stopAll}), and either with deskd restarted too (a desk
 * stop); the desk then starts again on the same files and its runs resume. Kill points are named events on the run's
 * own path, each counted, so a test can kill at the n-th one.
 *
 * <p>Its fault kinds are W7's harness's ({@code POST /fault}: {@code kill-desk-agent}, {@code restart-deskd}) and its
 * oracle ({@link #violations}) is the property test's, so both can move into {@code sub/mm-harness} as they are.
 */
final class ResumeRig implements AutoCloseable {

    static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    /** What a call is. */
    enum Kind {
        /** {@code files_list}: a read, {@code safe}. */
        READ,
        /** {@code files_write} the member approves: {@code retry_by_key}. */
        WRITE,
        /** {@code files_write} deskd classes {@code send}. */
        SEND,
        /** {@code files_write} deskd classes {@code spend}. */
        SPEND,
        /** {@code files_mkdir} done without asking under the member's switch. */
        AUTO,
        /** {@code workspace_write}, the agent's own, run in desk-agent: {@code interrupt}. */
        OWN
    }

    /** What the member does with a card. */
    enum Decision { APPROVE, DECLINE, EXPIRE }

    /** Where a fault strikes: the n-th of these events on the run's path. */
    enum Point {
        /** A model call under way. */
        MODEL,
        /** A step's plan written. */
        PLANNED,
        /** A card pending. */
        CARD,
        /** A step's verdicts written. */
        ADMITTED,
        /** A call's record started, nothing sent. */
        STARTED,
        /** deskd ran the call and kept its reply; the answer never got back. */
        DESKD,
        /** A call's result and record written. */
        RESULT
    }

    /** What the fault is. */
    enum Fault {
        /** desk-agent killed; deskd keeps its keys and tickets. */
        KILL(false, false),
        /** desk-agent killed and deskd restarted: keys and tickets lost. */
        KILL_DESKD(false, true),
        /** SIGTERM to desk-agent (a rollout): runs pause. */
        PAUSE(true, false),
        /** The desk stopped: desk-agent's SIGTERM, and deskd restarted. */
        STOP_DESK(true, true);

        final boolean pause;
        final boolean deskd;

        Fault(boolean pause, boolean deskd) {
            this.pause = pause;
            this.deskd = deskd;
        }

        /** Whether this fault can strike there: a pause only where the run waits, as SIGTERM finds it. */
        boolean at(Point point) {
            return !pause || point == Point.MODEL || point == Point.CARD || point == Point.DESKD;
        }
    }

    /** Thrown on a killed process's thread: it dies there. An {@link Error}, so nothing on its way catches it. */
    static final class Killed extends Error {
        private static final long serialVersionUID = 1L;

        Killed() {
            super("killed", null, false, false);
        }
    }

    final Path data;
    final MutableClock clock;
    final Deskd deskd = new Deskd();
    TeamDesk desk;
    Link link;
    String agent;
    /** The model's steps: each a list of calls; then a last answer. */
    final List<List<ToolCall>> script = new ArrayList<>();
    /** Each call's kind and the member's decision, by its path. */
    final Map<String, Kind> kinds = new HashMap<>();
    final Map<String, Decision> decisions = new HashMap<>();
    /** The run, once sent. */
    String runId;
    /** What the run's checkpoint held as the fault struck, and what it held once resumed. */
    final List<Map<String, Object>> booksAtFault = new ArrayList<>();
    final List<Map<String, Object>> booksAfterResume = new ArrayList<>();
    final List<String> violations = new CopyOnWriteArrayList<>();
    int faults;
    /** How long the desk is down at a fault: the clock moves on by this before it starts again. */
    Duration downtime = Duration.ZERO;
    /** Done to the files while the desk is down, after the fault and before it starts again. */
    ThrowingRunnable whileDown = () -> {};

    interface ThrowingRunnable {
        void run() throws Exception;
    }

    // ---- the armed fault
    private volatile Point armed;
    private volatile int armedAt;
    private volatile Fault armedFault;
    private final Map<Point, AtomicInteger> seen = new ConcurrentHashMap<>();
    private volatile CountDownLatch reached = new CountDownLatch(1);
    private volatile CountDownLatch killed = new CountDownLatch(1);
    /** A model call the fault strikes in waits on this, which is never let go: a stop or a pause cancels it. */
    private final CountDownLatch modelHold = new CountDownLatch(1);
    /** Generation of the desk now: hooks of an older one never fire again. */
    private final AtomicInteger generation = new AtomicInteger();

    ResumeRig(Path data, MutableClock clock) throws Exception {
        this.data = data;
        this.clock = clock;
        open(false);
        agent = desk.agent("Alice");
    }

    // ---------------------------------------------------------------- the script

    /** One step of calls of these kinds; each call's path is unique, so each is told apart wherever it runs. */
    ResumeRig step(Kind... callKinds) {
        int s = script.size() + 1;
        List<ToolCall> calls = new ArrayList<>();
        for (int i = 0; i < callKinds.length; i++) {
            String id = "s" + s + "c" + i;
            Kind kind = callKinds[i];
            ToolCall call = switch (kind) {
                case READ -> new ToolCall(id, "files_list", Map.of("path", id));
                case WRITE -> new ToolCall(id, "files_write", Map.of("path", id + ".md", "text", "x"));
                case SEND -> new ToolCall(id, "files_write", Map.of("path", "send-" + id + ".md", "text", "x"));
                case SPEND -> new ToolCall(id, "files_write", Map.of("path", "spend-" + id + ".md", "text", "x"));
                case AUTO -> new ToolCall(id, "files_mkdir", Map.of("path", "Auto/dir-" + id));
                case OWN -> new ToolCall(id, "workspace_write", Map.of("path", "own-" + id + ".md", "text", "x"));
            };
            calls.add(call);
            kinds.put(pathOf(call), kind);
            decisions.putIfAbsent(pathOf(call), Decision.APPROVE);
        }
        script.add(calls);
        return this;
    }

    /** The member's decision for the call at this step and index. */
    ResumeRig decide(int step, int index, Decision decision) {
        decisions.put(pathOf(script.get(step - 1).get(index)), decision);
        return this;
    }

    static String pathOf(ToolCall call) {
        return String.valueOf(call.input().get("path"));
    }

    /** Faults armed after the first, each for the desk after the one before struck. */
    private final java.util.ArrayDeque<Object[]> queued = new java.util.ArrayDeque<>();

    /**
     * Arms a fault for the {@code nth} (1 for the first) of {@code point}'s events; with one armed already, the next
     * one, counted in the desk that resumes after it.
     */
    ResumeRig fault(Point point, int nth, Fault fault) {
        if (armed != null) {
            queued.add(new Object[] {point, nth, fault});
            return this;
        }
        armed = point;
        armedAt = nth;
        armedFault = fault;
        reached = new CountDownLatch(1);
        killed = new CountDownLatch(1);
        seen.clear();
        return this;
    }

    // ---------------------------------------------------------------- the desk

    private void open(boolean again) throws Exception {
        int gen = generation.incrementAndGet();
        desk = new TeamDesk(data, clock);
        link = deskd.link(gen);
        desk.service.deskLink(link);
        desk.service.agentTools().confirmFor(Duration.ofSeconds(3));
        // AUTO's switch: files_mkdir done without asking, in the folder the switch names (the draft ADR's §15).
        LowRisk files = new LowRisk(Map.of("files_mkdir", "files"));
        desk.service.approvals().lowRiskForTest(files);
        desk.service.approvals().policy(ApprovalPolicy.perAgentWithPlaces(
                id -> new LowRisk.Switches(Set.of("files"), null, "Auto"), files));
        deskd.looks.put("files_write", c -> {
            Map<?, ?> args = (Map<?, ?>) c.get("args");
            String path = String.valueOf(args.get("path"));
            String risk = path.startsWith("send-") ? "send" : path.startsWith("spend-") ? "spend" : "write";
            return FakeDeskLink.look(risk, "agent", Map.of("path", path, "text", "x"), null);
        });
        deskd.looks.put("files_mkdir", c -> FakeDeskLink.look("write", "agent",
                Map.of("path", String.valueOf(((Map<?, ?>) c.get("args")).get("path"))), null));
        // The model, by step: the number of tool-call turns in the request says which step it's on, so a resumed run
        // that asks again gets the same step.
        desk.provider.onChat = request -> {
            int step = 0;
            for (ChatMessage m : request.messages()) {
                if (!m.toolCalls().isEmpty()) {
                    step++;
                }
            }
            Step next = step < script.size() ? Step.calls(USAGE, script.get(step), "Step " + (step + 1) + ".")
                    : Step.answer(USAGE, "All done.");
            if (gen == generation.get() && armed == Point.MODEL
                    && seen.computeIfAbsent(Point.MODEL, p -> new AtomicInteger()).incrementAndGet() == armedAt) {
                // The fault strikes while the model answers: the call hangs until the process is gone.
                next = next.heldBy(modelHold);
                reached.countDown();
            }
            desk.provider.then(next);
        };
        desk.service.runCalls().atCheckpointForTest(name -> hook(gen, switch (name) {
            case "planned" -> Point.PLANNED;
            case "admitted" -> Point.ADMITTED;
            default -> Point.RESULT;
        }));
        desk.service.runCalls().afterStartedForTest(key -> hook(gen, Point.STARTED));
        if (again) {
            desk.resume();
        }
    }

    /**
     * An event on the run's path, in desk {@code gen}: if it's the armed one, the fault strikes here, and this thread
     * (the killed process's) dies once it has.
     */
    private void hook(int gen, Point point) {
        if (gen != generation.get() || armed != point || point == Point.CARD || point == Point.MODEL) {
            return;
        }
        if (seen.computeIfAbsent(point, p -> new AtomicInteger()).incrementAndGet() != armedAt) {
            return;
        }
        reached.countDown();
        boolean interrupted = false;
        while (true) {
            try {
                killed.await();
                break;
            } catch (InterruptedException e) {
                interrupted = true;
            }
        }
        if (interrupted) {
            Thread.currentThread().interrupt();
        }
        throw new Killed();
    }

    /** The member sends the task. */
    void send(String text) throws Exception {
        runId = (String) desk.call("agent.message.send", "agentId", agent, "text", text).get("runId");
    }

    /**
     * Drives the run to its end: decides each card as planned, strikes the armed fault where it's reached, restarts the
     * desk and lets its runs resume, and goes on. @return the reply as it ended
     */
    Map<String, Object> drive() throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(40);
        Set<String> decided = new HashSet<>();
        int cards = 0;
        while (System.nanoTime() < until) {
            if (armed != null && reached.getCount() == 0) {
                strike();
                continue;
            }
            List<Map<String, Object>> thread = desk.thread(agent);
            Map<String, Object> last = thread.get(thread.size() - 1);
            if ("assistant".equals(last.get("role")) && List.of("done", "failed", "stopped").contains(last.get("state"))) {
                return last;
            }
            for (Map<String, Object> card : list(desk.call("agent.approvals.list", "agentId", agent).get("approvals"))) {
                if (!"pending".equals(card.get("state")) || decided.contains((String) card.get("id"))) {
                    continue;
                }
                cards++;
                if (armed == Point.CARD && cards == armedAt && reached.getCount() > 0) {
                    reached.countDown();
                    break;
                }
                decided.add((String) card.get("id"));
                Decision d = decisions.getOrDefault(String.valueOf(map(card.get("payload")).get("path")),
                        Decision.APPROVE);
                try {
                    switch (d) {
                        case APPROVE -> approve(card);
                        case DECLINE -> desk.call("agent.approval.decide", "approvalId", card.get("id"), "approve",
                                false, "sha256", sha(card));
                        case EXPIRE -> {
                            clock.advance(Duration.ofHours(25));
                            desk.service.approvals().wake();
                        }
                    }
                } catch (com.minimalistalliance.desk.agent.service.RpcError e) {
                    // Too late: another card's wait moved the clock past this one's time. It expires, as it would.
                    if (!"conflict".equals(e.code())) {
                        throw e;
                    }
                    deskd.tickets.remove((String) card.get("id"));
                }
            }
            Thread.sleep(10);
        }
        throw new AssertionError("the run didn't end: " + desk.thread(agent).getLast());
    }

    void approve(Map<String, Object> card) throws Exception {
        // deskd relays the member's yes, keeping a ticket as it goes: used once, lost if deskd restarts.
        deskd.tickets.add((String) card.get("id"));
        desk.call("agent.approval.decide", "approvalId", card.get("id"), "approve", true, "sha256", sha(card));
    }

    static String sha(Map<String, Object> card) {
        return Approvals.hash((String) card.get("agentId"), (String) card.get("runId"), (String) card.get("tool"),
                (String) card.get("context"), map(card.get("payload")));
    }

    /** The fault strikes: the old desk goes as the fault says, deskd restarts if it does, and a new one resumes. */
    private void strike() throws Exception {
        Fault fault = armedFault;
        faults++;
        armed = null;
        booksAtFault.add(book());
        if (fault.pause) {
            // SIGTERM: runs pause, then the files close.
            Thread closer = Thread.ofVirtual().start(desk::close);
            closer.join(Duration.ofSeconds(20));
            link.dead = true;
        } else {
            link.dead = true;
            var old = desk.service;
            desk.kill();
            // Whatever the dead process's run waits on (the model, a card) ends with it, here, and never goes on.
            try {
                old.call("agent.run.stop", TeamDesk.m("runId", runId));
            } catch (Exception e) {
                // Gone already.
            }
        }
        killed.countDown();
        if (fault.deskd) {
            deskd.restart();
        }
        clock.advance(downtime);
        whileDown.run();
        Object[] next = queued.poll();
        if (next != null) {
            fault((Point) next[0], (Integer) next[1], (Fault) next[2]);
        }
        open(true);
        booksAfterResume.add(book());
    }

    /** The run's taint and gate counts as its checkpoint holds them now, or as the live run does once resumed. */
    private Map<String, Object> book() {
        if (runId == null) {
            return Map.of();
        }
        Map<String, Object> live = desk.service.approvals().book(runId);
        RunContext context = desk.service.approvals().run(runId);
        if (!live.isEmpty() && context != null) {
            Map<String, Object> b = new LinkedHashMap<>(live);
            List<String> taint = new ArrayList<>();
            context.taint().forEach(t -> taint.add(t.name()));
            b.put("taint", taint);
            return b;
        }
        try {
            RunStore.Run row = desk.service.runCalls().checkpoints().store().run(runId);
            return row == null || row.book() == null ? Map.of()
                    : Json.parseObject(row.book().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            return Map.of();
        }
    }

    // ---------------------------------------------------------------- the oracle

    /**
     * What the run broke, once it ended (empty: nothing): every call ran at most once and only with the member's yes or
     * switch; no call, card or reply left open; the model got an answer for every call it made; taint and gate counts
     * never went down across a fault.
     */
    List<String> check(Map<String, Object> reply) throws Exception {
        List<String> out = new ArrayList<>(violations);
        if (!List.of("done", "failed", "stopped").contains(reply.get("state"))) {
            out.add("reply ended " + reply.get("state"));
        }
        // 0 double executions: one key, one effect; one call (by its unique path), one effect.
        Map<String, Integer> byPath = new HashMap<>();
        for (Map<String, Object> e : deskd.executed) {
            byPath.merge(String.valueOf(e.get("path")), 1, Integer::sum);
            if (!Boolean.TRUE.equals(e.get("cleared"))) {
                out.add("ran without the member's relayed yes or switch: " + e.get("path"));
            }
        }
        byPath.forEach((path, n) -> {
            if (n > 1) {
                out.add("ran " + n + " times: " + path);
            }
        });
        deskd.byKey.forEach((key, n) -> {
            if (n > 1) {
                out.add("a key took effect " + n + " times");
            }
        });
        // A call asked again by its key binds what its first sending bound: deskd never answers it key_mismatch.
        for (Map<String, Object> m : deskd.mismatched) {
            out.add("refused key_mismatch on a resend: " + m.get("tool") + " " + map(m.get("args")).get("path"));
        }
        // Gated calls ran only for the member's yes: each approved execution's approval is one the member approved.
        for (Map<String, Object> e : deskd.executed) {
            if (e.get("approvalId") instanceof String id) {
                Map<String, Object> card = map(desk.call("agent.approval.get", "approvalId", id).get("approval"));
                if (card.get("decidedBy") == null || "declined".equals(card.get("state"))) {
                    out.add("ran on an approval the member didn't approve: " + id);
                }
            }
        }
        // Every approval and record ended.
        for (Map<String, Object> card : list(desk.call("agent.approvals.list", "agentId", agent, "state", "all")
                .get("approvals"))) {
            if (!List.of("done", "failed", "declined", "expired", "interrupted").contains(card.get("state"))) {
                out.add("an approval left " + card.get("state"));
            }
        }
        for (RunCallStore.Call c : desk.service.runCalls().store().ofRun(runId)) {
            if ("started".equals(c.state())) {
                out.add("a call record left started: " + c.tool());
            }
        }
        // 0 silent losses: the model's last request answers every call it made, once each.
        List<ChatRequest> requests = desk.requests();
        if ("done".equals(reply.get("state")) && !requests.isEmpty()) {
            ChatRequest lastRequest = requests.get(requests.size() - 1);
            Set<String> asked = new HashSet<>();
            Set<String> answered = new HashSet<>();
            for (ChatMessage m : lastRequest.messages()) {
                m.toolCalls().forEach(c -> asked.add(c.id()));
                for (ToolResult r : m.toolResults()) {
                    if (!answered.add(r.callId())) {
                        out.add("a call answered twice: " + r.callId());
                    }
                }
            }
            if (!asked.equals(answered)) {
                out.add("calls the model never got an answer for: " + asked + " vs " + answered);
            }
        }
        // Taint and caps never shrink across a fault.
        for (int i = 0; i < Math.min(booksAtFault.size(), booksAfterResume.size()); i++) {
            Map<String, Object> before = booksAtFault.get(i);
            Map<String, Object> after = booksAfterResume.get(i);
            if (before.isEmpty() || after.isEmpty()) {
                continue;
            }
            for (String count : List.of("toolCalls", "asked", "declines", "egress")) {
                if (num(after.get(count)) < num(before.get(count))) {
                    out.add(count + " shrank: " + before.get(count) + " to " + after.get(count));
                }
            }
            for (String set : List.of("taint", "declinedHashes", "sites")) {
                if (!strings(after.get(set)).containsAll(strings(before.get(set)))) {
                    out.add(set + " shrank across a fault");
                }
            }
        }
        if (!desk.audit.verify().intact()) {
            out.add("the audit chain broke");
        }
        return out;
    }

    /** What the model read for the call at this path. */
    String resultFor(String path) {
        for (ChatRequest request : desk.requests()) {
            Map<String, String> ids = new HashMap<>();
            for (ChatMessage m : request.messages()) {
                for (ToolCall c : m.toolCalls()) {
                    ids.put(c.id(), pathOf(c));
                }
                for (ToolResult r : m.toolResults()) {
                    if (path.equals(ids.get(r.callId()))) {
                        return r.content();
                    }
                }
            }
        }
        return null;
    }

    private static long num(Object o) {
        return o instanceof Number n ? n.longValue() : 0;
    }

    private static Set<String> strings(Object o) {
        Set<String> out = new HashSet<>();
        if (o instanceof List<?> l) {
            l.forEach(x -> out.add(String.valueOf(x)));
        }
        return out;
    }

    @Override
    public void close() {
        killed.countDown();
        reached.countDown();
        desk.close();
    }

    // ---------------------------------------------------------------- deskd

    /**
     * deskd as it keeps calls (API.md §18, "Keys"): a call's reply kept by its key with what the key binds (deskd's
     * {@code ToolHost.fingerprint}: run, agent, tool, arguments, approval, switch and context, as they cross the
     * socket), the same key answered from it and run once, another call under that key refused {@code key_mismatch},
     * {@code retry} for a key it doesn't hold refused {@code key_unknown}; an approved call run only on a ticket the
     * member's decision relayed, used once; a restart loses both. It counts every execution.
     */
    final class Deskd {
        final Map<String, Map<String, Object>> keptReplies = new ConcurrentHashMap<>();
        /** What each kept key bound when it ran. */
        final Map<String, String> fingerprints = new ConcurrentHashMap<>();
        /** Calls refused {@code key_mismatch}: a resend that bound something else. */
        final List<Map<String, Object>> mismatched = new CopyOnWriteArrayList<>();
        final Map<String, Integer> byKey = new ConcurrentHashMap<>();
        final List<Map<String, Object>> executed = new CopyOnWriteArrayList<>();
        final Set<String> tickets = ConcurrentHashMap.newKeySet();
        final Map<String, java.util.function.Function<Map<String, Object>, DeskLink.Reply>> looks =
                new ConcurrentHashMap<>();
        private final java.util.concurrent.locks.ReentrantLock lock = new java.util.concurrent.locks.ReentrantLock();

        Link link(int gen) {
            return new Link(gen);
        }

        /** deskd restarted: its kept replies and tickets are gone. */
        void restart() {
            keptReplies.clear();
            fingerprints.clear();
            tickets.clear();
        }

        /** The kept reply for a key, or {@code key_mismatch} when this call isn't the one that ran under it. */
        private DeskLink.Reply replay(String key, Map<String, Object> call) {
            if (!com.minimalistalliance.desk.agent.testing.KeyFingerprint.of(call).equals(fingerprints.get(key))) {
                mismatched.add(call);
                return FakeDeskLink.refused("bad_request", "key_mismatch");
            }
            return reply(keptReplies.get(key));
        }

        DeskLink.Reply look(Map<String, Object> call) {
            var look = looks.get((String) call.get("tool"));
            if (look != null) {
                return look.apply(call);
            }
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("risk", null);
            r.put("context", "agent");
            r.put("target", Map.of());
            r.put("payload", call.get("args"));
            return new DeskLink.Reply(true, r, null, null, List.of());
        }

        /** One run-phase call: from what's kept, or run once and kept. */
        DeskLink.Reply run(Map<String, Object> call) {
            String key = (String) call.get("key");
            lock.lock();
            try {
                if (Boolean.TRUE.equals(call.get("retry"))) {
                    Map<String, Object> kept = key == null ? null : keptReplies.get(key);
                    return kept == null ? FakeDeskLink.refused("conflict", "key_unknown") : replay(key, call);
                }
                if (key != null && keptReplies.containsKey(key)) {
                    return replay(key, call);
                }
                Map<?, ?> args = (Map<?, ?>) call.get("args");
                String path = String.valueOf(args.get("path"));
                Kind kind = kinds.get(path);
                boolean cleared;
                String approvalId = null;
                if (call.get("approval") instanceof Map<?, ?> approval) {
                    approvalId = (String) approval.get("approvalId");
                    cleared = tickets.remove(approvalId);
                    if (!cleared) {
                        return FakeDeskLink.refused("forbidden", "approval_unknown");
                    }
                } else if (call.get("auto") != null) {
                    cleared = kind == Kind.AUTO;
                } else {
                    cleared = kind == Kind.READ || kind == Kind.OWN;
                }
                Map<String, Object> e = new LinkedHashMap<>();
                e.put("path", path);
                e.put("tool", call.get("tool"));
                e.put("key", key);
                e.put("approvalId", approvalId);
                e.put("cleared", cleared);
                executed.add(e);
                if (key != null) {
                    byKey.merge(key, 1, Integer::sum);
                }
                Map<String, Object> kept = Map.of("content", "did " + path);
                if (key != null) {
                    keptReplies.put(key, kept);
                    fingerprints.put(key, com.minimalistalliance.desk.agent.testing.KeyFingerprint.of(call));
                }
                return reply(kept);
            } finally {
                lock.unlock();
            }
        }

        private DeskLink.Reply reply(Map<String, Object> r) {
            return new DeskLink.Reply(true, r, null, null, List.of());
        }
    }

    /** One desk-agent process's link to deskd: dead once that process is, and then it never reaches deskd again. */
    final class Link implements DeskLink {
        private final int gen;
        volatile boolean dead;

        Link(int gen) {
            this.gen = gen;
        }

        @Override
        public Set<String> offered() {
            return Set.copyOf(FakeDeskLink.allHosted());
        }

        @Override
        public boolean keyed() {
            return true;
        }

        @Override
        public Reply call(Map<String, Object> call, Duration wait) throws InterruptedException {
            if (dead) {
                throw new Killed();
            }
            if ("look".equals(call.get("phase"))) {
                return deskd.look(call);
            }
            if ("run_end".equals(call.get("tool"))) {
                return new Reply(true, Map.of(), null, null, List.of());
            }
            Reply reply = deskd.run(call);
            if (gen == generation.get() && armed == Point.DESKD && !Boolean.TRUE.equals(call.get("retry"))
                    && seen.computeIfAbsent(Point.DESKD, p -> new AtomicInteger()).incrementAndGet() == armedAt) {
                // deskd ran it and kept its reply; the answer never gets back to this process.
                reached.countDown();
                killed.await();
                throw new Killed();
            }
            if (dead) {
                throw new Killed();
            }
            return reply;
        }
    }

    /** The kinds a test may ask of a run, for the property test's draws. */
    static final List<Kind> KINDS = List.copyOf(EnumSet.allOf(Kind.class));
}
