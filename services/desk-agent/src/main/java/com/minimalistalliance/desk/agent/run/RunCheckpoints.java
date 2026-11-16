package com.minimalistalliance.desk.agent.run;

import com.minimalistalliance.desk.agent.approval.Verdict;
import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.Role;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.store.RunCallStore;
import com.minimalistalliance.desk.agent.store.RunStore;
import com.minimalistalliance.desk.agent.tool.Classified;
import com.minimalistalliance.desk.agent.tool.Restart;
import com.minimalistalliance.desk.agent.tool.Risk;
import com.minimalistalliance.desk.agent.tool.RunContext;
import com.minimalistalliance.desk.agent.tool.Taint;
import com.minimalistalliance.desk.agent.tool.ToolDecl;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Clock;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Each run's checkpoints in {@code agent.db} (durable runs, Design 1; the draft ADR's §3, "Restarts"; ADR 0020's
 * checkpointed state machine), and what a restart reads back of them ({@link #load}).
 *
 * <ol>
 *   <li>{@link #begin}: the run's start context, once, as it starts (the instructions it was told, the thread it read,
 *       what started it, its cap).
 *   <li>{@link #planned}: a step's plan once its model call is back, before anything of it runs, with the run's taint
 *       and gate counts ({@code book}), none of which a resume may reset.
 *   <li>{@link #admitted}: the gate's verdicts for the step.
 *   <li>{@link #result}: each call's result as the model reads it and its chip, in one transaction with its record
 *       ({@code run_calls}), so neither is ever down without the other.
 * </ol>
 *
 * <p><b>Bounded.</b> A run's checkpoint holds at most {@link #CAP} bytes: the start context plus each step's delta,
 * never the whole conversation again. A run past it keeps going and can't resume ({@code resumable} 0, its checkpoint
 * gone), so a restart ends it {@code interrupted}, as before durable runs. A run whose start can't be kept (attachments
 * stay in memory, ADR 0049) is the same from its start. Each write is one transaction of a few KB (a result is cut at
 * 20,000 characters), a few ms with {@code synchronous=FULL}.
 *
 * <p><b>Security.</b> The tool results a run read sit in {@code agent.db} while it lasts, as its reply's text already
 * does; they go when it ends, with {@code secure_delete}. Nothing here logs content.
 */
public final class RunCheckpoints {

    private static final Logger log = LoggerFactory.getLogger(RunCheckpoints.class);

    /** The most a run's checkpoint may hold. */
    public static final long CAP = 2L << 20;

    private final RunStore store;
    private final Clock clock;
    private volatile long cap = CAP;
    /** A run's gate counts as the approvals keep them ({@code Approvals.book}), for each checkpoint. */
    private volatile Function<String, Map<String, Object>> books = runId -> Map.of();
    /** The declarations, by tool name: a plan names its calls' tools, never copies them. */
    private volatile Function<String, ToolDecl> decls = name -> null;

    /** For tests only: runs on the run's thread after each checkpoint write, with its name. */
    private volatile java.util.function.Consumer<String> hook = name -> {};

    public RunCheckpoints(RunStore store, Clock clock) {
        this.store = store;
        this.clock = clock;
    }

    public RunStore store() {
        return store;
    }

    /** Where each checkpoint reads the run's gate counts. */
    public void books(Function<String, Map<String, Object>> runBooks) {
        this.books = runBooks == null ? runId -> Map.of() : runBooks;
    }

    /** Where a plan read back finds its calls' declarations. */
    public void decls(Function<String, ToolDecl> byName) {
        this.decls = byName == null ? name -> null : byName;
    }

    /** For tests only: {@code planned}, {@code admitted} or {@code result} after each write, on the run's thread. */
    public void hook(java.util.function.Consumer<String> afterWrite) {
        this.hook = afterWrite == null ? name -> {} : afterWrite;
    }

    /** For tests only: a smaller cap. */
    public void capForTest(long bytes) {
        this.cap = bytes <= 0 ? CAP : bytes;
    }

    // ---------------------------------------------------------------- writing

    /** The run starts: its row and start context ({@code start.resumable()} false: kept, and never resumed). */
    public void begin(RunContext run, Resume.Start start) {
        if (run.messageId() == null) {
            return;
        }
        long now = clock.millis();
        String startJson = null;
        boolean resumable = start != null && start.resumable();
        if (resumable) {
            try {
                startJson = text(startMap(start));
            } catch (RuntimeException e) {
                resumable = false;
            }
        }
        try {
            store.begin(new RunStore.Run(run.runId(), run.agentId(), run.messageId(), "running", null, resumable, 0,
                    startJson, resumable ? text(book(run)) : null, 0, 0, now, now, null), cap);
        } catch (SQLException | RuntimeException e) {
            log.warn("a run's start wasn't checkpointed: {}", e.getClass().getSimpleName());
        }
    }

    /** A step's plan, before anything of it runs. */
    public void planned(RunContext run, Resume.Plan plan) {
        long now = clock.millis();
        Map<String, Object> book = book(run);
        Map<String, Object> planned = planMap(plan);
        // How many steps' asks the book held as this step was planned: a book holding more holds this one's too.
        planned.put("admits", book.getOrDefault("admits", 0));
        guarded(run, () -> store.planned(run.runId(), new RunStore.Step(plan.step(), text(planned), null, now),
                text(book), now, cap));
        hook.accept("planned");
    }

    /** The step's verdicts. */
    public void admitted(RunContext run, int step, List<Verdict> verdicts) {
        List<Object> list = new ArrayList<>();
        for (Verdict v : verdicts) {
            list.add(verdictMap(v));
        }
        guarded(run, () -> store.admitted(run.runId(), step, text(Map.of("verdicts", list)), text(book(run)),
                clock.millis(), cap));
        hook.accept("admitted");
    }

    /**
     * A call's result and chip fields, with its record's outcome ({@code key} null for a call that never ran), in one
     * transaction. The record settles even when the checkpoint can't take the result.
     */
    public void result(RunContext run, int step, int index, ToolResult forModel, Map<String, Object> fields,
            String key, String state, String detail) throws SQLException {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("content", forModel.content());
        r.put("error", forModel.error());
        r.put("fields", fields == null ? Map.of() : fields);
        try {
            store.result(run.runId(), new RunStore.Result(step, index, text(r)), key, state, detail, text(book(run)),
                    clock.millis(), cap);
        } catch (RunStore.Full full) {
            log.info("a run's checkpoint is full: it goes on, and won't resume after a restart");
        }
        hook.accept("result");
    }

    /** The run's counts changed between its checkpoints (asks recorded, a decline, an expiry): its book, now. */
    public void saveBook(RunContext run) {
        if (run == null || run.messageId() == null) {
            return;
        }
        guarded(run, () -> store.book(run.runId(), text(book(run)), clock.millis()));
    }

    /** ADR 0020's state while it runs: {@code running}, {@code waiting_approval}, {@code waiting_<kind>}. */
    public void state(String runId, String state) {
        try {
            store.state(runId, state, null, clock.millis());
        } catch (SQLException | RuntimeException e) {
            log.warn("a run's state wasn't recorded: {}", e.getClass().getSimpleName());
        }
    }

    /** Stopped on the way down (SIGTERM, a rollout or the desk's stop): {@code paused}, and it resumes at the next start. */
    public void paused(String runId, String why) {
        try {
            store.state(runId, "paused", why, clock.millis());
        } catch (SQLException | RuntimeException e) {
            log.warn("a run's pause wasn't recorded: {}", e.getClass().getSimpleName());
        }
    }

    /** The run ended: {@code done}, {@code failed}, {@code stopped} or {@code interrupted}. Its checkpoint goes. */
    public void ended(String runId, String state, String detail) {
        try {
            store.ended(runId, state, detail, clock.millis());
        } catch (SQLException | RuntimeException e) {
            log.warn("a run's end wasn't recorded: {}", e.getClass().getSimpleName());
        }
    }

    /** It can't resume from here on (a step's write failed): its checkpoint goes, and a restart ends it interrupted. */
    public void unresumable(String runId, String why) {
        try {
            store.unresumable(runId, why, clock.millis());
        } catch (SQLException | RuntimeException e) {
            log.warn("a run's checkpoint wasn't dropped: {}", e.getClass().getSimpleName());
        }
    }

    @FunctionalInterface
    private interface Write {
        void run() throws SQLException;
    }

    /**
     * A write that fails leaves the run without a whole checkpoint: it can't resume, and says so, rather than resume
     * from a gap. A full checkpoint has dropped itself already.
     */
    private void guarded(RunContext run, Write write) {
        if (run.messageId() == null) {
            return;
        }
        try {
            write.run();
        } catch (RunStore.Full full) {
            log.info("a run's checkpoint is full: it goes on, and won't resume after a restart");
        } catch (SQLException | RuntimeException e) {
            log.warn("a run's checkpoint wasn't written: {}", e.getClass().getSimpleName());
            unresumable(run.runId(), "storage");
        }
    }

    private Map<String, Object> book(RunContext run) {
        Map<String, Object> book = new LinkedHashMap<>(books.apply(run.runId()));
        List<String> taint = new ArrayList<>();
        for (Taint t : run.taint()) {
            taint.add(t.name());
        }
        book.put("taint", taint);
        return book;
    }

    // ---------------------------------------------------------------- reading back

    /**
     * A run a restart left, as read back: what it resumes with, what it started with, its gate counts, its taint and
     * how often it was resumed before; or {@code broken} when its checkpoint doesn't read whole (then it ends
     * {@code interrupted}, as before durable runs).
     */
    public record Loaded(RunStore.Run row, Resume resume, Resume.Start start, Map<String, Object> book,
            Set<Taint> taint, List<Long> plannedAt, boolean counted, boolean broken) {

        /** The approvals asked in the step it resumes inside are those created from its plan on. */
        public long pendingSince() {
            return resume == null || resume.pending() == null || plannedAt.isEmpty() ? Long.MAX_VALUE
                    : plannedAt.getLast();
        }

        /** No content in logs. */
        @Override
        public String toString() {
            return "Loaded[" + row + (broken ? ", broken" : "") + "]";
        }
    }

    /** Every run a restart left that can resume, read back. */
    public List<Loaded> resumable(RunCallStore calls) throws SQLException {
        List<Loaded> out = new ArrayList<>();
        for (RunStore.Run row : store.resumable()) {
            out.add(load(row, calls));
        }
        return out;
    }

    /** One run read back from its row, steps, results and call records. */
    public Loaded load(RunStore.Run row, RunCallStore calls) {
        try {
            Map<String, Object> start = parse(row.start());
            // A book that's missing, or holds no taint, is a broken checkpoint: it never resumes as clean (DR-L4).
            Map<String, Object> book = parse(row.book());
            if (!(book.get("taint") instanceof List<?>)) {
                return broken(row);
            }
            Resume.Start begun = start(start);
            List<ChatMessage> conversation = new ArrayList<>(begun.thread());
            List<RunStore.Step> steps = store.steps(row.runId());
            Map<Integer, Map<Integer, Resume.Settled>> results = new HashMap<>();
            for (RunStore.Result r : store.results(row.runId())) {
                Map<String, Object> m = parse(r.result());
                results.computeIfAbsent(r.step(), s -> new HashMap<>()).put(r.index(), new Resume.Settled(
                        new ToolResult("x", (String) m.get("content"), Boolean.TRUE.equals(m.get("error"))),
                        map(m.get("fields"))));
            }
            int finished = 0;
            Resume.Plan last = null;
            Resume.Pending pending = null;
            boolean counted = false;
            List<Long> plannedAt = new ArrayList<>();
            for (RunStore.Step s : steps) {
                Map<String, Object> planMap = parse(s.plan());
                Resume.Plan plan = plan(planMap);
                plannedAt.add(s.plannedAt());
                Map<Integer, Resume.Settled> done = results.getOrDefault(s.step(), Map.of());
                Map<Integer, Resume.Settled> settled = new HashMap<>();
                done.forEach((i, r) -> settled.put(i, new Resume.Settled(
                        new ToolResult(plan.calls().get(i).id(), r.forModel().content(), r.forModel().error()),
                        r.fields())));
                boolean whole = true;
                List<ToolResult> inOrder = new ArrayList<>();
                for (int i = 0; i < plan.calls().size(); i++) {
                    ToolResult r = plan.early().containsKey(i) ? plan.early().get(i)
                            : settled.containsKey(i) ? settled.get(i).forModel() : null;
                    if (r == null) {
                        whole = false;
                        break;
                    }
                    inOrder.add(r);
                }
                last = plan;
                if (whole && s.verdicts() != null || whole && plan.classified().isEmpty()) {
                    conversation.add(ChatMessage.toolCalls(plan.text(), plan.calls()));
                    conversation.add(ChatMessage.toolResults(inOrder));
                    finished = s.step();
                    continue;
                }
                if (s != steps.getLast()) {
                    // Only the newest step can be unfinished: an older one with a gap is a broken checkpoint.
                    return broken(row);
                }
                List<Verdict> verdicts = null;
                if (s.verdicts() != null) {
                    verdicts = new ArrayList<>();
                    for (Object v : (List<?>) parse(s.verdicts()).get("verdicts")) {
                        verdicts.add(verdict(map(v)));
                    }
                    if (verdicts.size() != plan.classified().size()) {
                        return broken(row);
                    }
                }
                Map<String, Resume.InFlight> inFlight = new HashMap<>();
                for (RunCallStore.Call c : calls.ofRun(row.runId())) {
                    if (c.step() == s.step() && "started".equals(c.state())) {
                        inFlight.put(c.callId(), new Resume.InFlight(c.key(), restart(c.restart())));
                    }
                }
                pending = new Resume.Pending(plan, verdicts, settled, inFlight);
                counted = verdicts == null && num(book.get("admits")) > num(planMap.get("admits"));
            }
            List<Map<String, Object>> chips = new ArrayList<>();
            String text = last == null ? "" : last.reply();
            Usage usage = last == null ? null : last.usage();
            Long cost = last == null ? null : last.cost();
            Set<Taint> taint = EnumSet.noneOf(Taint.class);
            if (book.get("taint") instanceof List<?> flags) {
                for (Object f : flags) {
                    taint.add(Taint.valueOf(String.valueOf(f)));
                }
            }
            return new Loaded(row, new Resume(row.runId(), conversation, finished, text, chips, usage, cost, pending),
                    begun, book, taint, plannedAt, counted, false);
        } catch (RuntimeException | SQLException | JsonFormatException e) {
            log.warn("a run's checkpoint didn't read back: {}", e.getClass().getSimpleName());
            return broken(row);
        }
    }

    private static Loaded broken(RunStore.Run row) {
        return new Loaded(row, null, null, Map.of(), EnumSet.noneOf(Taint.class), List.of(), false, true);
    }

    /** The resume with the reply's text and chips as they were last written ({@code messages}). */
    public static Resume withReply(Resume resume, String text, List<Map<String, Object>> chips) {
        return new Resume(resume.runId(), resume.conversation(), resume.steps(),
                text == null || text.length() < resume.text().length() ? resume.text() : text, chips, resume.usage(),
                resume.costMicroUsd(), resume.pending());
    }

    // ---------------------------------------------------------------- the codec

    private static Map<String, Object> startMap(Resume.Start start) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("v", 1);
        // Not the instructions: a resumed run is told them as they are then, so a memory line the member deleted
        // meanwhile isn't kept here or sent again (Security's DR-L7).
        List<Object> thread = new ArrayList<>();
        for (ChatMessage message : start.thread()) {
            if (!message.attachments().isEmpty()) {
                throw new IllegalArgumentException("attachments stay in memory");
            }
            thread.add(messageMap(message));
        }
        m.put("thread", thread);
        m.put("origin", start.origin());
        m.put("chain", start.chain());
        m.put("maxMicroUsd", start.maxMicroUsd());
        return m;
    }

    private static Resume.Start start(Map<String, Object> m) {
        List<ChatMessage> thread = new ArrayList<>();
        for (Object o : (List<?>) m.get("thread")) {
            thread.add(message(map(o)));
        }
        return new Resume.Start(null, thread, mapOrNull(m.get("origin")),
                mapOrNull(m.get("chain")), m.get("maxMicroUsd") instanceof Number n ? n.longValue() : null, true);
    }

    private static Map<String, Object> messageMap(ChatMessage message) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("role", message.role().name());
        m.put("text", message.text());
        if (!message.toolCalls().isEmpty()) {
            m.put("calls", calls(message.toolCalls()));
        }
        if (!message.toolResults().isEmpty()) {
            List<Object> results = new ArrayList<>();
            for (ToolResult r : message.toolResults()) {
                results.add(resultMap(r));
            }
            m.put("results", results);
        }
        return m;
    }

    private static ChatMessage message(Map<String, Object> m) {
        List<ToolCall> calls = m.get("calls") instanceof List<?> list ? readCalls(list) : List.of();
        List<ToolResult> results = new ArrayList<>();
        if (m.get("results") instanceof List<?> list) {
            for (Object o : list) {
                results.add(result(map(o)));
            }
        }
        return new ChatMessage(Role.valueOf((String) m.get("role")), (String) m.get("text"), calls, results);
    }

    private static List<Object> calls(List<ToolCall> calls) {
        List<Object> out = new ArrayList<>();
        for (ToolCall c : calls) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", c.id());
            m.put("name", c.name());
            m.put("input", c.input());
            m.put("malformed", c.malformed());
            if (!c.reasoning().isEmpty()) {
                m.put("reasoning", c.reasoning());
            }
            out.add(m);
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static List<ToolCall> readCalls(List<?> list) {
        List<ToolCall> out = new ArrayList<>();
        for (Object o : list) {
            Map<String, Object> m = map(o);
            List<Map<String, Object>> reasoning = new ArrayList<>();
            if (m.get("reasoning") instanceof List<?> items) {
                for (Object item : items) {
                    reasoning.add((Map<String, Object>) item);
                }
            }
            out.add(new ToolCall((String) m.get("id"), (String) m.get("name"), map(m.get("input")),
                    Boolean.TRUE.equals(m.get("malformed")), reasoning));
        }
        return out;
    }

    private static Map<String, Object> resultMap(ToolResult r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("callId", r.callId());
        m.put("content", r.content());
        m.put("error", r.error());
        return m;
    }

    private static ToolResult result(Map<String, Object> m) {
        return new ToolResult((String) m.get("callId"), (String) m.get("content"), Boolean.TRUE.equals(m.get("error")));
    }

    private static Map<String, Object> planMap(Resume.Plan plan) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("step", plan.step());
        m.put("text", plan.text());
        m.put("reply", plan.reply());
        m.put("calls", calls(plan.calls()));
        Map<String, Object> early = new LinkedHashMap<>();
        plan.early().forEach((i, r) -> early.put(String.valueOf(i), resultMap(r)));
        m.put("early", early);
        List<Object> classified = new ArrayList<>();
        for (Classified c : plan.classified()) {
            Map<String, Object> cm = new LinkedHashMap<>();
            cm.put("tool", c.decl().name());
            cm.put("risk", c.risk().wireName());
            cm.put("context", c.context());
            cm.put("target", c.target());
            cm.put("payload", c.payload());
            cm.put("before", c.before());
            cm.put("refusal", c.refusal());
            classified.add(cm);
        }
        m.put("classified", classified);
        m.put("at", plan.at());
        if (plan.usage() != null) {
            Usage u = plan.usage();
            m.put("usage", List.of(u.inputTokens(), u.cachedInputTokens(), u.cacheWriteTokens(), u.outputTokens(),
                    u.reasoningTokens()));
        }
        m.put("cost", plan.cost());
        return m;
    }

    private Resume.Plan plan(Map<String, Object> m) {
        List<ToolCall> calls = readCalls((List<?>) m.get("calls"));
        Map<Integer, ToolResult> early = new HashMap<>();
        map(m.get("early")).forEach((i, r) -> early.put(Integer.parseInt(i), result(map(r))));
        List<Integer> at = new ArrayList<>();
        for (Object o : (List<?>) m.get("at")) {
            at.add(((Number) o).intValue());
        }
        List<Classified> classified = new ArrayList<>();
        List<?> list = (List<?>) m.get("classified");
        for (int k = 0; k < list.size(); k++) {
            Map<String, Object> cm = map(list.get(k));
            ToolDecl decl = decls.apply((String) cm.get("tool"));
            if (decl == null) {
                throw new IllegalStateException("no such tool now");
            }
            classified.add(new Classified(calls.get(at.get(k)), decl, Risk.fromWire((String) cm.get("risk")),
                    (String) cm.get("context"), map(cm.get("target")), map(cm.get("payload")),
                    mapOrNull(cm.get("before")), (String) cm.get("refusal")));
        }
        Usage usage = null;
        if (m.get("usage") instanceof List<?> u && u.size() == 5) {
            usage = new Usage(num(u.get(0)), num(u.get(1)), num(u.get(2)), num(u.get(3)), num(u.get(4)));
        }
        return new Resume.Plan(((Number) m.get("step")).intValue(), (String) m.get("text"), (String) m.get("reply"),
                calls, early, classified, at, usage, m.get("cost") instanceof Number c ? c.longValue() : null);
    }

    static Map<String, Object> verdictMap(Verdict v) {
        Map<String, Object> m = new LinkedHashMap<>();
        switch (v) {
            case Verdict.Auto a -> m.put("kind", "auto");
            case Verdict.Allowed a -> {
                m.put("kind", "allowed");
                m.put("group", a.group());
                m.put("approvalId", a.approvalId());
            }
            case Verdict.Approved a -> {
                m.put("kind", "approved");
                m.put("approvalId", a.approvalId());
                m.put("sha256", a.sha256());
            }
            case Verdict.Declined d -> {
                m.put("kind", "declined");
                m.put("approvalId", d.approvalId());
                m.put("note", d.note());
            }
            case Verdict.Expired x -> {
                m.put("kind", "expired");
                m.put("approvalId", x.approvalId());
                m.put("detail", x.detail());
                m.put("expiresAt", x.expiresAt());
            }
            case Verdict.Refused r -> {
                m.put("kind", "refused");
                m.put("reason", r.reason());
            }
        }
        return m;
    }

    static Verdict verdict(Map<String, Object> m) {
        String id = (String) m.get("approvalId");
        return switch ((String) m.get("kind")) {
            case "auto" -> Verdict.Auto.INSTANCE;
            case "allowed" -> new Verdict.Allowed((String) m.get("group"), id);
            case "approved" -> new Verdict.Approved(id, (String) m.get("sha256"));
            case "declined" -> new Verdict.Declined(id, (String) m.get("note"));
            case "expired" -> new Verdict.Expired(id, (String) m.get("detail"), num(m.get("expiresAt")));
            case "refused" -> new Verdict.Refused((String) m.get("reason"));
            default -> throw new IllegalArgumentException("verdict");
        };
    }

    private static Restart restart(String wire) {
        for (Restart r : Restart.values()) {
            if (r.wireName().equals(wire)) {
                return r;
            }
        }
        return Restart.INTERRUPT;
    }

    private static long num(Object o) {
        return o instanceof Number n ? n.longValue() : 0L;
    }

    private static String text(Object value) {
        return new String(Json.bytes(value), StandardCharsets.UTF_8);
    }

    private static Map<String, Object> parse(String json) throws JsonFormatException {
        if (json == null) {
            throw new JsonFormatException();
        }
        return Json.parseObject(json.getBytes(StandardCharsets.UTF_8));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object o) {
        if (o == null) {
            return new LinkedHashMap<>();
        }
        return (Map<String, Object>) o;
    }

    private static Map<String, Object> mapOrNull(Object o) {
        return o == null ? null : map(o);
    }
}
