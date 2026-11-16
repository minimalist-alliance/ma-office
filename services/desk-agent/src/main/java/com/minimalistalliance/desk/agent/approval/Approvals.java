package com.minimalistalliance.desk.agent.approval;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.store.MessageRow;
import com.minimalistalliance.desk.agent.team.Canonical;
import com.minimalistalliance.desk.agent.team.TextChecks;
import com.minimalistalliance.desk.agent.tool.Classified;
import com.minimalistalliance.desk.agent.tool.Risk;
import com.minimalistalliance.desk.agent.tool.RunContext;
import com.minimalistalliance.desk.agent.tool.Taint;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Predicate;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The approval gate (draft ADR "the Agent's tools and approvals", sections 3, 4, 6 and 7; deskd's {@code API.md}
 * section 18): where a step's calls that need the member's yes wait for it, the {@code approvals} rows, the three
 * {@code agent.approval*} methods, the {@code approval} event, and each run's flags as its reply keeps them.
 *
 * <p><b>Who decides.</b> Only {@link #decide}, which deskd relays from a session of the agent's owner with input:
 * the desk's owner for their agents, a guild member for their own. Nothing a run does reaches it.
 *
 * <p><b>States.</b> {@code pending} → {@code approved} (running) → {@code done}, {@code failed} or
 * {@code interrupted}; or {@code pending} → {@code declined} or {@code expired}. Every move is made once: in memory a
 * live approval is claimed under {@link #lock} before its row changes, and the row's update names the state it leaves.
 * An approved call that never started (its run stopped first) is {@code expired} too: nothing was done.
 *
 * <p><b>Waiting.</b> {@link #admit} asks every call of the step that needs it at once, then blocks the run's thread
 * until each is decided or past its time (1 hour in a run the member started, 24 in one a timer or another agent
 * started). A stop interrupts it, and its pending approvals expire {@code stopped} (or {@code age_band}). On the way
 * down ({@link #pausing}) nothing expires: the run pauses, and at the next start {@link #resume} makes its cards live
 * again, still answerable until their own time (durable runs). {@link #restore} sweeps what a restart left of runs
 * that don't resume.
 */
public final class Approvals implements ApprovalGate {

    private static final Logger log = LoggerFactory.getLogger(Approvals.class);

    static final Duration MEMBER_LIFE = Duration.ofHours(1);
    static final Duration UNATTENDED_LIFE = Duration.ofHours(24);
    /** Tool calls a run may make: the ADR's {@code toolCallsPerRun}, the same on every tier for now. */
    static final int TOOL_CALLS_PER_RUN = 100;
    static final int ASKS_PER_RUN = 10;
    static final int PENDING_PER_AGENT = 5;
    static final int PENDING_ON_DESK = 20;
    static final int DECLINES_PER_RUN = 3;
    static final int SITES_PER_RUN = 2;
    /** Calls done without asking (the draft ADR's §15): a run, and an agent a day by the member's midnight. */
    static final int AUTO_PER_RUN = 20;
    static final int AUTO_PER_DAY = 100;
    /** Over this much JSON a payload is left out of events, snapshots, pages and lists. */
    static final int EVENT_PAYLOAD_MAX = 32 << 10;
    /** The most JSON a payload may be, so {@code agent.approval.get} always fits deskd's RES. */
    static final int PAYLOAD_MAX = 900 << 10;
    static final int LIST_PAGE = 50;
    static final int LIST_BYTES = 900 << 10;
    static final int NOTE_MAX = 500;
    /** The longest one wait sleeps before it looks at the clock again. */
    static final Duration WAIT_SLICE = Duration.ofSeconds(30);
    /** The tool that grants the member's signed-in session for one site (§5). */
    static final String SESSION_TOOL = "browser_use_my_session";

    private static final Pattern ID = Pattern.compile("ap-[a-z2-7]{20}");
    private static final Pattern AGENT_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final char[] BASE32 = "abcdefghijklmnopqrstuvwxyz234567".toCharArray();

    /** {@code AgentService}'s side: where events go. Must not block on the gate. */
    public interface Host {
        /** An approval was asked or changed: the {@code approval} event on the agent's conversation. */
        void approval(String agentId, Map<String, Object> view);

        /** A run started or stopped waiting: its reply's {@code state} and {@code pendingApprovals} changed. */
        void waiting(String agentId, String runId, String messageId);

        /** The agent's {@code approvalsPending} or {@code statusDetail} changed. */
        void state(String agentId);
    }

    /** One run's book: its counts and its live approvals. Under {@link #lock}. */
    private static final class Book {
        final RunContext run;
        int toolCalls;
        int asked;
        int declines;
        int egress;
        final Set<String> declinedHashes = new HashSet<>();
        /** Calls done without asking in this run, reserved as they're let through. */
        int autoCount;
        /** Payloads deskd refused to run unasked in this run: the model's next try asks on a card instead. */
        final Set<String> autoRefused = new HashSet<>();
        final Set<String> sites = new HashSet<>();
        final Map<String, Entry> entries = new LinkedHashMap<>();
        /** Why the desk is ending this run, when it is: {@code age_band}, {@code restart}; null for a member's stop. */
        String endDetail;
        /**
         * After a restart (durable runs): the approvals this run asked in the step it picks up inside, oldest first. That
         * step is admitted again, and a call whose hash is here takes this approval, as it was or as it is now, rather
         * than being asked twice.
         */
        final List<ApprovalStore.Row> prior = new ArrayList<>();
        /** How many steps' asks this book has counted: a checkpoint's book says whether it holds a step's already. */
        int admits;
        /** A resumed step whose counts the book already holds: admitted again without counting them twice. */
        boolean counted;

        Book(RunContext run) {
            this.run = run;
        }
    }

    /** A live approval. Under {@link #lock}. */
    private static final class Entry {
        final String id;
        final String agentId;
        final String runId;
        final String messageId;
        final String tool;
        final String sha256;
        final long expiresAt;
        /** Its class, as asked: an {@code egress} call counts on the run as it starts. */
        String risk = "";
        /** For a call done without asking, its group; null for a card. */
        String autoGroup;
        /** For a call done without asking, whether its run was one the member didn't start. */
        boolean unattended;
        String state = "pending";
        String detail;
        String note;
        /** A decision or an expiry is writing its row: nothing else may move it meanwhile. */
        boolean claimed;
        boolean started;

        Entry(String id, String agentId, String runId, String messageId, String tool, String sha256, long expiresAt) {
            this.id = id;
            this.agentId = agentId;
            this.runId = runId;
            this.messageId = messageId;
            this.tool = tool;
            this.sha256 = sha256;
            this.expiresAt = expiresAt;
        }

        boolean pending() {
            return state.equals("pending");
        }
    }

    private final ApprovalStore store;
    private final AuditLog audit;
    private final Clock clock;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition changed = lock.newCondition();
    private final Map<String, Book> books = new HashMap<>();
    private final Map<String, Entry> live = new HashMap<>();
    private volatile Host host = new Host() {
        @Override
        public void approval(String agentId, Map<String, Object> view) {}

        @Override
        public void waiting(String agentId, String runId, String messageId) {}

        @Override
        public void state(String agentId) {}
    };
    /** Whether {@code agent.db} has any approval or mark, so a desk that never asked reads nothing for them. */
    private volatile boolean any;
    /** Told, with the run's id, when a run's counts changed outside a step's checkpoint (durable runs). */
    private volatile java.util.function.Consumer<String> bookChanged = runId -> {};
    /**
     * The process is going down and its runs pause (durable runs): a wait that ends now expires nothing, and a run's end
     * interrupts nothing; its approvals stay as they are, and its run picks them up at the next start.
     */
    private volatile boolean pausing;
    /** Ask, or the member's setting for an agent: ask always until the ADR's access record holds the switches. */
    private volatile ApprovalPolicy policy = ApprovalPolicy.ASK_ALWAYS;
    /**
     * The low-risk class the gate checks again for every call a policy lets through (Security's ATC-L1): the ADR's, so
     * however a policy is wired, it can only narrow it. Tests put a class of their own here.
     */
    private volatile LowRisk lowRisk = LowRisk.ADR;
    /** The member's zone, whose midnight ends an agent's day of calls done without asking (ADR 0043's day). */
    private volatile java.util.function.Supplier<java.time.ZoneId> zone = () -> java.time.ZoneOffset.UTC;
    /** Each agent's calls done without asking today: {dayStart, count}. Under {@link #lock}. */
    private final Map<String, long[]> autoDays = new HashMap<>();
    /**
     * Each agent's calls done without asking in runs the member didn't start, done, not undone and not yet seen: what its
     * tile counts (the draft ADR's §15). Kept in {@code approvals.auto_seen}; this is its count.
     */
    private final Map<String, Integer> autoUnseen = new java.util.concurrent.ConcurrentHashMap<>();

    public Approvals(AgentStore agents, AuditLog audit, Clock clock) {
        this.store = new ApprovalStore(agents);
        this.audit = audit;
        this.clock = clock;
    }

    public void attach(Host newHost) {
        this.host = newHost;
    }

    /** Whether a call that would ask is asked, or done without asking under its agent's switches. Null is ask, always. */
    public void policy(ApprovalPolicy newPolicy) {
        this.policy = newPolicy == null ? ApprovalPolicy.ASK_ALWAYS : newPolicy;
    }

    /**
     * The class the gate checks a policy's answer against, in place of the ADR's. For tests only: a desk keeps
     * {@link LowRisk#ADR}. Null puts the ADR's back.
     */
    public void lowRiskForTest(LowRisk newClass) {
        this.lowRisk = newClass == null ? LowRisk.ADR : newClass;
    }

    /** The member's zone, for the day's count of calls done without asking. Null is UTC. */
    public void zone(java.util.function.Supplier<java.time.ZoneId> memberZone) {
        this.zone = memberZone == null ? () -> java.time.ZoneOffset.UTC : memberZone;
    }

    /** The start of today in the member's zone, ms. */
    private long dayStart(long now) {
        java.time.ZoneId in;
        try {
            in = zone.get();
        } catch (RuntimeException e) {
            in = null;
        }
        if (in == null) {
            in = java.time.ZoneOffset.UTC;
        }
        return java.time.Instant.ofEpochMilli(now).atZone(in).toLocalDate().atStartOfDay(in).toInstant().toEpochMilli();
    }

    /** Under {@link #lock}: this agent's count today, from {@code today}. */
    private long[] autoDay(String agentId, long today) {
        long[] day = autoDays.computeIfAbsent(agentId, id -> new long[] {today, 0});
        if (day[0] != today) {
            day[0] = today;
            day[1] = 0;
        }
        return day;
    }

    /**
     * The policy's answer for one call that would ask, kept only when the gate's own low-risk class puts the call in that
     * same group; any failure of either asks. Called under {@link #lock}, so a policy must answer from memory and never
     * call back into the gate.
     */
    private String allowedBy(Classified call, RunContext run) {
        try {
            String group = policy.allows(call, run);
            if (group == null || group.isBlank()) {
                return null;
            }
            // Whatever the policy says, a call is done unasked only inside the class: never a follow_up, a memory save,
            // anything but an adding write in the agent's own context, or anything after U (LowRisk's rules).
            return group.equals(lowRisk.groupOf(call, run)) ? group : null;
        } catch (RuntimeException e) {
            log.warn("the approval policy failed, so it asks: {}", e.getClass().getSimpleName());
            return null;
        }
    }

    // ---------------------------------------------------------------- the run's side

    /**
     * After {@code agent.db} opens, with no run going: what a restart left. Pending approvals and approved ones whose
     * tool never started become {@code expired} with {@code detail: "restart"}; approved ones whose tool had started
     * become {@code interrupted}, as deskd finishes a call it already began. Nothing re-runs.
     */
    public void restore() throws SQLException {
        restore(Set.of());
    }

    /**
     * {@link #restore()}, leaving the approvals of runs that resume ({@code resuming}) as they are: a pending card stays
     * pending and answerable ({@link #resume}), until its own {@code expiresAt}.
     */
    public void restore(Set<String> resuming) throws SQLException {
        long now = clock.millis();
        for (ApprovalStore.Row row : store.sweepAtOpen(now, resuming)) {
            boolean interrupted = row.state().equals("approved") && row.startedAt() != null;
            audit("agent:" + row.agentId(), interrupted ? "approval.interrupt" : "approval.expire",
                    target(row.id(), row.tool(), row.runId()), null, "restart");
        }
        any = !store.newestFirst(null, false, null, now, 1).isEmpty() || store.anyMarks();
        autoUnseen.clear();
        autoUnseen.putAll(store.autoUnseen(null));
        // Today's calls done without asking count after a restart too.
        long today = dayStart(now);
        Map<String, Integer> counts = store.autoCountsSince(today);
        lock.lock();
        try {
            autoDays.clear();
            counts.forEach((agentId, n) -> autoDays.put(agentId, new long[] {today, n}));
        } finally {
            lock.unlock();
        }
    }

    /**
     * At open, before {@link #restore}: an approved call whose record says it came back ({@code run.RunCalls}) settles
     * {@code done} or {@code failed} with its word, rather than {@code interrupted}: the process ended between the call
     * and its approval's outcome. @return whether this moved it
     */
    public boolean settledFromRecord(String approvalId, boolean ok, String word) throws SQLException {
        if (approvalId == null) {
            return false;
        }
        Map<String, Object> outcome = new LinkedHashMap<>();
        outcome.put("ok", ok);
        if (!ok) {
            outcome.put("error", word == null ? "failed" : word);
        }
        return store.settle(approvalId, ok ? "done" : "failed", text(outcome));
    }

    /**
     * A step of the run is being written down (its reply's text and chips so far, durable runs' seam): the reply's marks
     * so far go first, so a reply a kill leaves with its text never reads unmarked to a later run in the thread
     * (Security's DS-M1). The run's end writes them again ({@link #ended}); both only ever raise them.
     *
     * @return whether the reply's marks are down (or there are none), so its text may be written
     */
    public boolean stepMarks(RunContext run) {
        if (run.messageId() == null) {
            return true;
        }
        int egress;
        lock.lock();
        try {
            Book book = books.get(run.runId());
            egress = book == null ? 0 : book.egress;
        } finally {
            lock.unlock();
        }
        if (!run.untrusted() && !run.privateData() && egress == 0) {
            return true;
        }
        try {
            store.putMarks(run.messageId(), run.agentId(), run.runId(),
                    new ApprovalStore.Marks(run.untrusted(), run.privateData(), egress));
            any = true;
            return true;
        } catch (SQLException e) {
            log.warn("a reply's marks weren't recorded: {}", e.getClass().getSimpleName());
            return false;
        }
    }

    /**
     * The run's gate counts as a checkpoint keeps them (durable runs): calls, asks, declines, egress, declined hashes and
     * sites. None of them may reset at a restart, or a run could ask past its caps or ask again what was declined.
     */
    public Map<String, Object> book(String runId) {
        lock.lock();
        try {
            Book book = books.get(runId);
            if (book == null) {
                return Map.of();
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("toolCalls", book.toolCalls);
            m.put("asked", book.asked);
            m.put("declines", book.declines);
            m.put("egress", book.egress);
            m.put("declinedHashes", new ArrayList<>(new java.util.TreeSet<>(book.declinedHashes)));
            m.put("sites", new ArrayList<>(new java.util.TreeSet<>(book.sites)));
            m.put("admits", book.admits);
            // The draft ADR's §15: calls done without asking in this run (20 at most), and payloads deskd refused unasked.
            m.put("autoCount", book.autoCount);
            m.put("autoRefused", new ArrayList<>(new java.util.TreeSet<>(book.autoRefused)));
            return m;
        } finally {
            lock.unlock();
        }
    }

    /**
     * A run picks up after a restart (durable runs): its book back as its checkpoint kept it, and its approvals live
     * again: a pending card stays pending and answerable (and expires at its own time), an approved one is the call's
     * verdict, one in flight settles as its call does. Those asked in the step it resumes inside (created at or after
     * {@code pendingSince}) are found again by their hash when that step is admitted again, never asked twice.
     */
    public void resume(RunContext run, Map<String, Object> saved, long pendingSince) throws SQLException {
        resume(run, saved, pendingSince, false);
    }

    /**
     * {@link #resume(RunContext, Map, long)}; {@code counted} when the book already holds the asks of the step it
     * resumes inside, which is then admitted again without counting them twice.
     */
    public void resume(RunContext run, Map<String, Object> saved, long pendingSince, boolean counted)
            throws SQLException {
        List<ApprovalStore.Row> rows = store.ofRun(run.runId());
        lock.lock();
        try {
            Book book = new Book(run);
            book.toolCalls = count(saved.get("toolCalls"));
            book.asked = count(saved.get("asked"));
            book.declines = count(saved.get("declines"));
            book.egress = count(saved.get("egress"));
            book.admits = count(saved.get("admits"));
            book.autoCount = count(saved.get("autoCount"));
            if (saved.get("autoRefused") instanceof List<?> refused) {
                refused.forEach(h -> book.autoRefused.add(String.valueOf(h)));
            }
            book.counted = counted;
            if (saved.get("declinedHashes") instanceof List<?> hashes) {
                hashes.forEach(h -> book.declinedHashes.add(String.valueOf(h)));
            }
            if (saved.get("sites") instanceof List<?> sites) {
                sites.forEach(site -> book.sites.add(String.valueOf(site)));
            }
            for (ApprovalStore.Row row : rows) {
                if (row.state().equals("pending") || row.state().equals("approved")) {
                    Entry e = new Entry(row.id(), row.agentId(), row.runId(), row.messageId(), row.tool(),
                            row.sha256(), row.expiresAt());
                    e.state = row.state();
                    e.started = row.startedAt() != null;
                    e.risk = row.risk();
                    e.autoGroup = row.autoGroup();
                    e.unattended = run.unattended();
                    book.entries.put(e.id, e);
                    live.put(e.id, e);
                }
                if (row.createdAt() >= pendingSince) {
                    book.prior.add(row);
                }
            }
            books.put(run.runId(), book);
            changed.signalAll();
        } finally {
            lock.unlock();
        }
        any = any || !rows.isEmpty();
    }

    /**
     * Where a run's counts go when they change between its checkpoints: asks recorded, a decline, an expiry (durable
     * runs). Called outside the gate's lock.
     */
    public void bookChanged(java.util.function.Consumer<String> sink) {
        this.bookChanged = sink == null ? runId -> {} : sink;
    }

    /** A run whose agent is gone ends with nothing written: its book goes (durable runs, Security's DR-L6). */
    public void forget(String runId) {
        lock.lock();
        try {
            Book book = books.remove(runId);
            if (book != null) {
                for (Entry e : book.entries.values()) {
                    live.remove(e.id);
                }
            }
            changed.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** The process is going down: its runs pause, and nothing they wait on expires (durable runs). */
    public void pausing() {
        pausing = true;
    }

    private static int count(Object value) {
        return value instanceof Number n ? n.intValue() : 0;
    }

    /** This run's own approval for this call, asked before a restart in the step being admitted again, or null. */
    private ApprovalStore.Row prior(Book book, RunContext run, Classified call) {
        if (book.prior.isEmpty()) {
            return null;
        }
        String sha;
        try {
            sha = hash(run.agentId(), run.runId(), call.decl().name(), call.context(), call.payload());
        } catch (IllegalArgumentException | ClassCastException e) {
            return null;
        }
        for (java.util.Iterator<ApprovalStore.Row> it = book.prior.iterator(); it.hasNext(); ) {
            ApprovalStore.Row row = it.next();
            if (row.sha256().equals(sha) && row.tool().equals(call.decl().name())) {
                it.remove();
                return row;
            }
        }
        return null;
    }

    /** A run begins: its book, before any of its steps. */
    public void begin(RunContext run) {
        lock.lock();
        try {
            books.putIfAbsent(run.runId(), new Book(run));
        } finally {
            lock.unlock();
        }
    }

    /** The run under way with this id, or null. */
    public RunContext run(String runId) {
        lock.lock();
        try {
            Book book = books.get(runId);
            return book == null ? null : book.run;
        } finally {
            lock.unlock();
        }
    }

    /**
     * The tools whose results never add {@code U} to a run (draft ADR §11): a listing of the member's own Files, a write's
     * or a trash's receipt, the agent's own workspace listing and writes, the desk's agents and choices, a proposal, the
     * plan, a follow-up, a memory saved or forgotten, a closed tab. None declares {@code U}, deskd
     * marks none of their results as it runs them, and desk-agent adds none. Every other tool's result can: one deskd may
     * mark as it runs (a marked page or tab, an untrusted to-do, a page's text, a message), a workspace file written while
     * reading untrusted content, another agent's answer, and any tool not named here, a new one included.
     */
    static final Set<String> NEVER_ADDS_UNTRUSTED = Set.of("files_list", "files_search", "files_write", "files_mkdir",
            "files_move", "files_trash", "browser_close", "desk_answer", "todo_add",
            "todo_update", "todo_close", "workspace_list", "workspace_write", "workspace_delete", "desk_agents",
            "desk_choices", "propose_agent", "propose_agent_change", "propose_agent_removal", "propose_links",
            "propose_timer", "propose_timer_removal", "plan_update", "follow_up", "memory_save", "memory_forget");

    /**
     * Whether this call's result can add {@code U} to its run once it runs: its declaration says so, or it isn't one of
     * {@link #NEVER_ADDS_UNTRUSTED}. A write after such a call in the same step asks, as the gate can't yet see what it
     * will add (Security's ATC-I1); after any other, the run is as clean as the gate sees it (API.md §18).
     */
    static boolean mayAddUntrusted(Classified call) {
        return call.decl().taints().contains(Taint.U) || !NEVER_ADDS_UNTRUSTED.contains(call.decl().name());
    }

    /**
     * Whether a run's calls need the member: every {@code write}, {@code delete}, {@code send}, {@code spend} and
     * {@code egress} in every run, and a memory save in a run that has read untrusted content.
     */
    static boolean asks(Classified call, RunContext run) {
        return call.risk().alwaysAsks() || (call.risk() == Risk.OWN && call.decl().isMemory() && run.untrusted());
    }

    /** The approval's hash: SHA-256 of the canonical JSON of {@code {v: 1, agentId, runId, tool, context, payload}}. */
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

    @Override
    public List<Verdict> admit(RunContext run, List<Classified> step) throws InterruptedException {
        return admit(run, step, false);
    }

    /**
     * {@link #admit} for calls desk-agent's own code makes (Desk Maia's notes, API.md §23), which never put a card in
     * front of the member: a call done without asking under the agent's switch is {@link Verdict.Allowed} as in a run,
     * with its row and Undo; one that would ask is {@link Verdict.Refused} {@code would_ask}, and nothing is asked.
     */
    public List<Verdict> admitUnasked(RunContext run, List<Classified> step) throws InterruptedException {
        return admit(run, step, true);
    }

    private List<Verdict> admit(RunContext run, List<Classified> step, boolean neverAsk) throws InterruptedException {
        Verdict[] out = new Verdict[step.size()];
        List<Integer> asking = new ArrayList<>();
        // After a restart: calls this step asked before it, matched by hash (durable runs).
        Map<Integer, ApprovalStore.Row> found = new HashMap<>();
        List<Integer> unasked = new ArrayList<>();
        Map<Integer, String> hashes = new HashMap<>();
        Map<Integer, String> payloads = new HashMap<>();
        long today = dayStart(clock.millis());
        // The agent's switches read now, outside the gate's lock, so the policy answers from memory under it (a first
        // read may reach SQLite: Security's AAW-I6).
        switchesOf(run.agentId());
        lock.lock();
        try {
            Book book = books.computeIfAbsent(run.runId(), id -> new Book(run));
            int agentPending = 0;
            int deskPending = 0;
            for (Entry e : live.values()) {
                if (e.pending()) {
                    deskPending++;
                    if (e.agentId.equals(run.agentId())) {
                        agentPending++;
                    }
                }
            }
            boolean spendAsked = false;
            // Whether a call before this one in the step will (or may) run, isn't itself done unasked, and has a result that
            // can add U before this call runs, which the run's flags don't show yet. deskd checks taint as each call runs,
            // so a write after it is asked here rather than refused there (Security's ATC-I1). One whose result never adds
            // U (a listing, the plan) leaves the run as clean as it is now (API.md §18; release 3's bug E).
            boolean earlierRuns = false;
            Set<String> sites = new HashSet<>(book.sites);
            // A step resumed whose asks the book already counted: nothing of it is counted again (durable runs).
            boolean recount = !book.counted;
            book.counted = false;
            for (int i = 0; i < step.size(); i++) {
                Classified call = step.get(i);
                earlierRuns |= i > 0 && !(out[i - 1] instanceof Verdict.Refused)
                        && !(out[i - 1] instanceof Verdict.Allowed) && mayAddUntrusted(step.get(i - 1));
                if (recount) {
                    book.toolCalls++;
                }
                if (book.toolCalls > TOOL_CALLS_PER_RUN) {
                    out[i] = new Verdict.Refused("tool_cap");
                    continue;
                }
                if (call.refusal() != null) {
                    out[i] = new Verdict.Refused(call.refusal());
                    continue;
                }
                if (!asks(call, run)) {
                    out[i] = Verdict.Auto.INSTANCE;
                    continue;
                }
                ApprovalStore.Row before = prior(book, run, call);
                if (before != null) {
                    // Asked before the restart: as it was decided, or still waiting for the member.
                    if (AUTO.equals(before.decidedBy()) && before.autoGroup() != null) {
                        // Done without asking before the restart, and not run yet: the same unasked call on its own row
                        // (the draft ADR's §15), counted once.
                        if (recount) {
                            book.autoCount++;
                        }
                        out[i] = "approved".equals(before.state()) && before.startedAt() == null
                                ? new Verdict.Allowed(before.autoGroup(), before.id())
                                : new Verdict.Expired(before.id(), "restart", before.expiresAt());
                        continue;
                    }
                    found.put(i, before);
                    if (recount) {
                        book.asked++;
                    }
                    if (SESSION_TOOL.equals(before.tool()) && parse(before.payload()).get("site") instanceof String s) {
                        book.sites.add(s);
                        sites.add(s);
                    }
                    // A decline or expiry counts once: unless the book's hashes show it was counted before the restart.
                    boolean uncounted = !book.declinedHashes.contains(before.sha256());
                    switch (before.state()) {
                        case "pending" -> {}
                        case "approved" -> out[i] = new Verdict.Approved(before.id(), before.sha256());
                        case "declined" -> {
                            out[i] = new Verdict.Declined(before.id(), before.note());
                            if (uncounted) {
                                book.declines++;
                                book.declinedHashes.add(before.sha256());
                            }
                        }
                        case "expired" -> {
                            out[i] = new Verdict.Expired(before.id(), before.detail() == null ? "timeout"
                                    : before.detail(), before.expiresAt());
                            if (before.startedAt() == null && uncounted) {
                                book.declines++;
                                book.declinedHashes.add(before.sha256());
                            }
                        }
                        default -> out[i] = new Verdict.Expired(before.id(), "restart", before.expiresAt());
                    }
                    continue;
                }
                String reason = null;
                String sha = null;
                String payload = null;
                if (call.risk() == Risk.SPEND && run.unattended()) {
                    reason = "unattended_spend";
                } else if (book.declines >= DECLINES_PER_RUN) {
                    reason = "declined";
                } else {
                    try {
                        payload = Canonical.json(call.payload());
                        sha = hash(run.agentId(), run.runId(), call.decl().name(), call.context(), call.payload());
                    } catch (IllegalArgumentException | ClassCastException e) {
                        reason = "payload";
                    }
                }
                if (reason == null && !book.declinedHashes.contains(sha)) {
                    // The member's setting for this agent, if they switched a group on: a low-risk write in its place is
                    // done without asking. Asked only here, after every refusal before asking and after the run's
                    // declines (a payload the member declined is never done unasked: Security's AAW-L1), within the
                    // counts; ask by default. A payload deskd refused to run unasked in this run asks.
                    long[] day = autoDay(run.agentId(), today);
                    String group = earlierRuns || book.autoRefused.contains(sha) || book.autoCount >= AUTO_PER_RUN
                            || day[1] >= AUTO_PER_DAY ? null : allowedBy(call, run);
                    if (group != null) {
                        book.autoCount++;
                        day[1]++;
                        out[i] = new Verdict.Allowed(group, newId());
                        unasked.add(i);
                        hashes.put(i, sha);
                        payloads.put(i, payload);
                        continue;
                    }
                }
                if (reason == null) {
                    String site = SESSION_TOOL.equals(call.decl().name()) && call.payload().get("site") instanceof String s
                            ? s : null;
                    int queued = asking.size();
                    if (book.declinedHashes.contains(sha)) {
                        reason = "declined_before";
                    } else if (call.risk() == Risk.SPEND && spendAsked) {
                        reason = "ask_cap";
                    } else if (book.asked + queued >= ASKS_PER_RUN || agentPending + queued >= PENDING_PER_AGENT
                            || deskPending + queued >= PENDING_ON_DESK) {
                        reason = "ask_cap";
                    } else if (site != null && !sites.contains(site) && sites.size() >= SITES_PER_RUN) {
                        reason = "ask_cap";
                    } else if (payload.getBytes(StandardCharsets.UTF_8).length > PAYLOAD_MAX) {
                        reason = "too_large";
                    } else if (site != null) {
                        sites.add(site);
                    }
                }
                if (reason == null && neverAsk) {
                    reason = "would_ask";
                }
                if (reason != null) {
                    out[i] = new Verdict.Refused(reason);
                    continue;
                }
                spendAsked |= call.risk() == Risk.SPEND;
                asking.add(i);
                hashes.put(i, sha);
                payloads.put(i, payload);
            }
        } finally {
            lock.unlock();
        }
        if (!unasked.isEmpty()) {
            recordUnasked(run, step, unasked, hashes, payloads, out);
        }
        // Cards asked before a restart that still wait: waited on with any asked now, never asked again.
        List<Integer> waitingAgain = new ArrayList<>();
        List<Entry> mine = new ArrayList<>();
        lock.lock();
        try {
            for (Map.Entry<Integer, ApprovalStore.Row> f : found.entrySet()) {
                if (out[f.getKey()] == null) {
                    Entry e = live.get(f.getValue().id());
                    if (e == null) {
                        out[f.getKey()] = new Verdict.Expired(f.getValue().id(), "restart", f.getValue().expiresAt());
                    } else {
                        waitingAgain.add(f.getKey());
                        mine.add(e);
                    }
                }
            }
        } finally {
            lock.unlock();
        }
        if (asking.isEmpty() && waitingAgain.isEmpty()) {
            return List.of(out);
        }

        long now = clock.millis();
        long expiresAt = now + (run.unattended() ? UNATTENDED_LIFE : MEMBER_LIFE).toMillis();
        String origin = text(run.origin());
        List<ApprovalStore.Row> rows = new ArrayList<>();
        for (int i : asking) {
            Classified call = step.get(i);
            rows.add(new ApprovalStore.Row(newId(), run.agentId(), run.runId(), run.messageId(), call.decl().name(),
                    call.risk().wireName(), call.title(), call.context(), text(call.target()), payloads.get(i),
                    call.before() == null ? null : text(call.before()), hashes.get(i), run.untrusted(), origin,
                    "pending", null, now, expiresAt, null, null, null, null, null));
        }
        try {
            if (!rows.isEmpty()) {
                store.insert(rows);
                any = true;
            }
        } catch (SQLException e) {
            log.warn("approvals weren't recorded: {}", e.getClass().getSimpleName());
            for (int i : asking) {
                out[i] = new Verdict.Refused("storage");
            }
            if (waitingAgain.isEmpty()) {
                return List.of(out);
            }
            asking.clear();
            rows.clear();
        }
        lock.lock();
        try {
            Book book = books.computeIfAbsent(run.runId(), id -> new Book(run));
            for (ApprovalStore.Row row : rows) {
                Entry e = new Entry(row.id(), row.agentId(), row.runId(), row.messageId(), row.tool(), row.sha256(),
                        row.expiresAt());
                e.risk = row.risk();
                book.entries.put(e.id, e);
                live.put(e.id, e);
                mine.add(e);
                book.asked++;
                if (SESSION_TOOL.equals(row.tool()) && parse(row.payload()).get("site") instanceof String site) {
                    book.sites.add(site);
                }
            }
        } finally {
            lock.unlock();
        }
        lock.lock();
        try {
            Book book = books.get(run.runId());
            if (book != null) {
                book.admits++;
            }
        } finally {
            lock.unlock();
        }
        // The step's counts and its asks, kept before anyone can answer them (durable runs).
        bookChanged.accept(run.runId());
        for (ApprovalStore.Row row : rows) {
            audit("agent:" + row.agentId(), "approval.ask", target(row.id(), row.tool(), row.runId()),
                    HexFormat.of().parseHex(row.sha256()), "ask:" + row.risk());
            host.approval(row.agentId(), view(row, false));
        }
        host.waiting(run.agentId(), run.runId(), run.messageId());
        host.state(run.agentId());

        try {
            await(mine);
        } catch (InterruptedException e) {
            if (pausing) {
                // On the way down: the cards stay pending, and the run picks them up at the next start.
                throw e;
            }
            String detail;
            lock.lock();
            try {
                Book book = books.get(run.runId());
                detail = book == null || book.endDetail == null ? "stopped" : book.endDetail;
            } finally {
                lock.unlock();
            }
            for (Entry entry : mine) {
                expire(entry, detail);
            }
            host.waiting(run.agentId(), run.runId(), run.messageId());
            host.state(run.agentId());
            throw e;
        }
        host.waiting(run.agentId(), run.runId(), run.messageId());
        host.state(run.agentId());

        lock.lock();
        try {
            List<Integer> order = new ArrayList<>(waitingAgain);
            order.addAll(asking);
            for (int k = 0; k < order.size(); k++) {
                Entry e = mine.get(k);
                out[order.get(k)] = switch (e.state) {
                    case "approved" -> new Verdict.Approved(e.id, e.sha256);
                    case "declined" -> new Verdict.Declined(e.id, e.note);
                    default -> new Verdict.Expired(e.id, e.detail == null ? "timeout" : e.detail, e.expiresAt);
                };
            }
        } finally {
            lock.unlock();
        }
        return List.of(out);
    }

    /**
     * The approval rows of the calls a step does without asking (the draft ADR's §15): {@code approved} by
     * {@code auto} now, before any of them runs, so a restart while one runs makes it {@code interrupted}, as a card's;
     * each becomes {@code done} or {@code failed} when it settles. A row that can't be kept is a call that doesn't run
     * ({@code storage}).
     */
    private void recordUnasked(RunContext run, List<Classified> step, List<Integer> unasked, Map<Integer, String> hashes,
            Map<Integer, String> payloads, Verdict[] out) {
        long now = clock.millis();
        String origin = text(run.origin());
        List<ApprovalStore.Row> rows = new ArrayList<>();
        LowRisk.Switches places = switchesOf(run.agentId());
        for (int i : unasked) {
            Classified call = step.get(i);
            Verdict.Allowed allowed = (Verdict.Allowed) out[i];
            Map<String, Object> place = new LinkedHashMap<>();
            place.put("group", allowed.group());
            if ("notebook".equals(allowed.group()) && places.notebookTab() != null) {
                place.put("tabId", places.notebookTab());
            } else if ("files".equals(allowed.group()) && places.filesFolder() != null) {
                place.put("folder", places.filesFolder());
            }
            rows.add(new ApprovalStore.Row(allowed.approvalId(), run.agentId(), run.runId(), run.messageId(),
                    call.decl().name(), call.risk().wireName(), call.title(), call.context(), text(call.target()),
                    payloads.get(i), call.before() == null ? null : text(call.before()), hashes.get(i),
                    run.untrusted(), origin, "approved", null, now, now, now, AUTO, null, null, null,
                    allowed.group(), text(place), null, null));
        }
        try {
            store.insert(rows);
            any = true;
            if (run.unattended()) {
                // A run the member didn't start: its tile counts what it did until they look (the ADR's §15).
                store.markUnseen(rows.stream().map(ApprovalStore.Row::id).toList());
            }
        } catch (SQLException e) {
            log.warn("calls done without asking weren't recorded: {}", e.getClass().getSimpleName());
            for (int i : unasked) {
                out[i] = new Verdict.Refused("storage");
            }
            return;
        }
        lock.lock();
        try {
            Book book = books.computeIfAbsent(run.runId(), id -> new Book(run));
            for (ApprovalStore.Row row : rows) {
                Entry e = new Entry(row.id(), row.agentId(), row.runId(), row.messageId(), row.tool(), row.sha256(),
                        row.expiresAt());
                e.state = "approved";
                e.autoGroup = row.autoGroup();
                e.unattended = run.unattended();
                book.entries.put(e.id, e);
                live.put(e.id, e);
            }
        } finally {
            lock.unlock();
        }
        for (ApprovalStore.Row row : rows) {
            host.approval(row.agentId(), view(row, false));
        }
    }

    /** {@code decidedBy} of a call done without asking. */
    static final String AUTO = "auto";

    /** The places of an agent's switches, for its rows: from the policy's source, or none. */
    private volatile java.util.function.Function<String, LowRisk.Switches> switches = id -> LowRisk.Switches.OFF;

    /** Where the agent's switches and their places come from, for the rows of calls done without asking. */
    public void switches(java.util.function.Function<String, LowRisk.Switches> source) {
        this.switches = source == null ? id -> LowRisk.Switches.OFF : source;
    }

    private LowRisk.Switches switchesOf(String agentId) {
        try {
            LowRisk.Switches on = switches.apply(agentId);
            return on == null ? LowRisk.Switches.OFF : on;
        } catch (RuntimeException e) {
            return LowRisk.Switches.OFF;
        }
    }

    /** Blocks until none of these is pending, expiring each that passes its time. */
    private void await(List<Entry> mine) throws InterruptedException {
        while (true) {
            List<Entry> due = new ArrayList<>();
            lock.lockInterruptibly();
            try {
                long now = clock.millis();
                boolean open = false;
                long next = Long.MAX_VALUE;
                for (Entry e : mine) {
                    if (!e.pending()) {
                        continue;
                    }
                    open = true;
                    if (e.claimed) {
                        continue;
                    }
                    if (now >= e.expiresAt) {
                        due.add(e);
                    } else {
                        next = Math.min(next, e.expiresAt);
                    }
                }
                if (!open) {
                    return;
                }
                if (due.isEmpty()) {
                    long wait = Math.max(1, Math.min(next - now, WAIT_SLICE.toMillis()));
                    changed.await(wait, TimeUnit.MILLISECONDS);
                    continue;
                }
            } finally {
                lock.unlock();
            }
            for (Entry e : due) {
                expire(e, "timeout");
            }
        }
    }

    /**
     * Expires one approval that is pending, or approved and never started, with this detail: its row, its entry, the
     * audit and the event. One already moved is left as it is.
     */
    private void expire(Entry e, String detail) {
        lock.lock();
        try {
            boolean open = (e.pending() || (e.state.equals("approved") && !e.started)) && !e.claimed;
            if (!open) {
                return;
            }
            e.claimed = true;
        } finally {
            lock.unlock();
        }
        try {
            store.expire(e.id, detail, clock.millis());
        } catch (SQLException ex) {
            // The run goes on as if it expired; the row stays pending and the next open sweeps it.
            log.warn("an approval's expiry wasn't recorded: {}", ex.getClass().getSimpleName());
        }
        boolean counts;
        lock.lock();
        try {
            counts = e.pending();
            e.state = "expired";
            e.detail = detail;
            e.claimed = false;
            Book book = books.get(e.runId);
            if (book != null && counts) {
                // An expiry counts as a decline (the ADR's 3-decline stop), and the same call isn't asked again.
                book.declines++;
                book.declinedHashes.add(e.sha256);
            }
            changed.signalAll();
        } finally {
            lock.unlock();
        }
        if (counts) {
            bookChanged.accept(e.runId);
        }
        audit("agent:" + e.agentId, "approval.expire", target(e.id, e.tool, e.runId), null, detail);
        publish(e.id);
    }

    /** Just before an approved call's tool runs: from here a restart makes it {@code interrupted}, not expired. */
    @Override
    public void starting(Verdict verdict) {
        String id = verdict instanceof Verdict.Approved approved ? approved.approvalId()
                : verdict instanceof Verdict.Allowed allowed ? allowed.approvalId() : null;
        if (id == null) {
            return;
        }
        lock.lock();
        try {
            Entry e = live.get(id);
            if (e != null) {
                e.started = true;
                // An egress call counts as it starts, so the count a step's checkpoint keeps is never behind a call
                // that may have happened (durable runs).
                Book book = books.get(e.runId);
                if (book != null && Risk.EGRESS.wireName().equals(e.risk)) {
                    book.egress++;
                }
            }
        } finally {
            lock.unlock();
        }
        try {
            store.started(id, clock.millis());
        } catch (SQLException e) {
            log.warn("an approval's start wasn't recorded: {}", e.getClass().getSimpleName());
        }
    }

    @Override
    public void settle(Verdict verdict, ToolResult result) {
        String id = verdict instanceof Verdict.Approved approved ? approved.approvalId()
                : verdict instanceof Verdict.Allowed allowed ? allowed.approvalId() : null;
        if (id == null) {
            return;
        }
        String error = result.error() ? errorWord(result) : null;
        Map<String, Object> outcome = new LinkedHashMap<>();
        outcome.put("ok", !result.error());
        if (error != null) {
            outcome.put("error", error);
        }
        // A call deskd may have run that its key couldn't confirm (a lost link): interrupted, as at a restart, never
        // failed, since it may have happened (durable runs' seam).
        boolean interrupted = com.minimalistalliance.desk.agent.tool.Restart.interrupted(result);
        String state = interrupted ? "interrupted" : result.error() ? "failed" : "done";
        try {
            store.settle(id, state, interrupted ? null : text(outcome));
        } catch (SQLException e) {
            log.warn("an approval's outcome wasn't recorded: {}", e.getClass().getSimpleName());
        }
        String unseenOf = null;
        lock.lock();
        try {
            Entry e = live.remove(id);
            if (e != null) {
                e.state = state;
                Book book = books.get(e.runId);
                if (book != null) {
                    book.entries.remove(e.id);
                    if (e.autoGroup != null && e.unattended && error == null) {
                        autoUnseen.merge(e.agentId, 1, Integer::sum);
                        unseenOf = e.agentId;
                    }
                    if (e.autoGroup != null && error != null && DESKD_REFUSED_AUTO.contains(error)) {
                        // deskd's own check didn't hold (its record, place, class, taint or counts): the model's next try
                        // of the same payload in this run asks on a card, as the ADR's "the model asks again".
                        book.autoRefused.add(e.sha256);
                    }
                }
            }
        } finally {
            lock.unlock();
        }
        publish(id);
        if (unseenOf != null) {
            // Its tile's count, published outside the gate's lock.
            host.state(unseenOf);
        }
    }

    /** deskd's refusals of a call done without asking, after which the same payload asks in this run. */
    static final Set<String> DESKD_REFUSED_AUTO = Set.of("approval_unknown", "approval_used", "place");

    /**
     * The call's audit row and its approval's outcome: {@code tool.call} with the payload's hash, and
     * {@code browser.session.grant} when the member's session was granted. Counts the run's {@code egress} calls.
     */
    @Override
    public void settle(RunContext run, Classified call, Verdict verdict, ToolResult result) {
        String decision;
        String approvalId = null;
        switch (verdict) {
            case Verdict.Auto a -> decision = outcome(result);
            case Verdict.Allowed a -> decision = outcome(result);
            case Verdict.Approved a -> {
                approvalId = a.approvalId();
                decision = outcome(result);
            }
            case Verdict.Declined d -> {
                approvalId = d.approvalId();
                decision = "refused:declined";
            }
            case Verdict.Expired x -> {
                approvalId = x.approvalId();
                decision = "refused:expired";
            }
            case Verdict.Refused r -> decision = "refused:" + r.reason();
        }
        String target = "tool:" + call.decl().name() + " run:" + run.runId()
                + (approvalId == null ? "" : " approval:" + approvalId)
                + (verdict instanceof Verdict.Allowed allowed ? " auto:" + word(allowed.group()) : "");
        audit("agent:" + run.agentId(), "tool.call", target, payloadHash(call), decision);
        if (verdict instanceof Verdict.Allowed allowed) {
            // The draft ADR's §7: every unasked call has its own row, the switch's group, its own approval id (which
            // deskd heard as autoApprovalId, and the Notebook keys its edit by) and the payload's hash. The tool.call row
            // names no approval, so Activity never reads it as the member's yes.
            audit("agent:" + run.agentId(), "approval.auto", "tool:" + call.decl().name() + " run:" + run.runId()
                    + " approval:" + allowed.approvalId() + " group:" + word(allowed.group()), payloadHash(call),
                    decision);
        }
        if (verdict instanceof Verdict.Approved && !result.error() && SESSION_TOOL.equals(call.decl().name())) {
            audit("agent:" + run.agentId(), "browser.session.grant", "site:" + clip(String.valueOf(
                    call.payload().get("site")), 120) + " run:" + run.runId(), null, "ok");
        }
        settle(verdict, result);
    }

    /**
     * A run ended, however: its book goes. What it left pending, or approved and never started, expires
     * ({@code stopped}, or the desk's reason); an approved call that started and never settled is {@code interrupted}.
     * The reply keeps the run's flags and its egress count.
     */
    public void ended(String runId) {
        ended(runId, false);
    }

    /**
     * {@link #ended(String)}; {@code paused} for a run SIGTERM paused (durable runs), whose cards and calls stay as they
     * are for its resume. Its reply's marks are written either way (Security's DR-L2).
     */
    public void ended(String runId, boolean paused) {
        Book book;
        List<Entry> open = new ArrayList<>();
        List<Entry> interrupted = new ArrayList<>();
        lock.lock();
        try {
            book = books.get(runId);
            if (book == null) {
                return;
            }
            for (Entry e : paused ? List.<Entry>of() : book.entries.values()) {
                if (e.pending() || (e.state.equals("approved") && !e.started)) {
                    open.add(e);
                } else if (e.state.equals("approved")) {
                    interrupted.add(e);
                }
            }
        } finally {
            lock.unlock();
        }
        String detail = book.endDetail == null ? "stopped" : book.endDetail;
        for (Entry e : open) {
            expire(e, detail);
        }
        for (Entry e : interrupted) {
            try {
                store.settle(e.id, "interrupted", null);
            } catch (SQLException ex) {
                log.warn("an interrupted approval wasn't recorded: {}", ex.getClass().getSimpleName());
            }
            audit("agent:" + e.agentId, "approval.interrupt", target(e.id, e.tool, e.runId), null, "ended");
            publish(e.id);
        }
        RunContext run = book.run;
        ApprovalStore.Marks marks;
        lock.lock();
        try {
            books.remove(runId);
            for (Entry e : book.entries.values()) {
                live.remove(e.id);
            }
            marks = new ApprovalStore.Marks(run.untrusted(), run.privateData(), book.egress);
            changed.signalAll();
        } finally {
            lock.unlock();
        }
        if (marks.untrusted() || marks.privateData() || marks.egress() > 0) {
            try {
                store.putMarks(run.messageId(), run.agentId(), runId, marks);
                any = true;
            } catch (SQLException e) {
                log.warn("a reply's marks weren't recorded: {}", e.getClass().getSimpleName());
            }
        }
        host.state(run.agentId());
    }

    /**
     * The desk is ending these runs for a reason of its own ({@code age_band}, {@code restart}): their waits expire
     * with it, rather than {@code stopped}, once the caller stops them.
     */
    public void ending(Predicate<String> agentIds, String detail) {
        lock.lock();
        try {
            for (Book book : books.values()) {
                if (agentIds.test(book.run.agentId())) {
                    book.endDetail = detail;
                }
            }
        } finally {
            lock.unlock();
        }
    }

    // ---------------------------------------------------------------- what the run looks like

    /** Wakes every wait to look at the clock now: for a clock that jumps, as a test's does. */
    public void wake() {
        lock.lock();
        try {
            changed.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** Whether this agent's run is waiting for the member now. */
    public boolean waiting(String agentId) {
        return pendingCount(agentId) > 0;
    }

    /** How many of this agent's approvals wait now: {@code agent.state}'s {@code approvalsPending}. */
    public int pendingCount(String agentId) {
        lock.lock();
        try {
            int n = 0;
            for (Entry e : live.values()) {
                if (e.pending() && e.agentId.equals(agentId)) {
                    n++;
                }
            }
            return n;
        } finally {
            lock.unlock();
        }
    }

    /** The ids a run waits on now, oldest first; empty when it isn't waiting. */
    public List<String> pendingOf(String runId) {
        lock.lock();
        try {
            Book book = books.get(runId);
            List<String> ids = new ArrayList<>();
            if (book != null) {
                for (Entry e : book.entries.values()) {
                    if (e.pending()) {
                        ids.add(e.id);
                    }
                }
            }
            return ids;
        } finally {
            lock.unlock();
        }
    }

    /**
     * The approvals and marks of a page's replies, read at once: the cards, the calls done without asking (each reply's
     * {@code auto}), and the runs' marks.
     */
    public record Decor(Map<String, List<Map<String, Object>>> approvals, Map<String, ApprovalStore.Marks> marks,
            Map<String, List<Map<String, Object>>> auto) {
        static final Decor NONE = new Decor(Map.of(), Map.of(), Map.of());

        public Decor(Map<String, List<Map<String, Object>>> approvals, Map<String, ApprovalStore.Marks> marks) {
            this(approvals, marks, Map.of());
        }
    }

    /** What these replies carry: their approvals (payloads over 32 KiB left out) and their runs' marks. */
    public Decor decor(Collection<MessageRow> rows) {
        if (!any) {
            return Decor.NONE;
        }
        List<String> ids = new ArrayList<>();
        for (MessageRow row : rows) {
            if ("assistant".equals(row.role())) {
                ids.add(row.id());
            }
        }
        if (ids.isEmpty()) {
            return Decor.NONE;
        }
        try {
            Map<String, List<Map<String, Object>>> views = new HashMap<>();
            Map<String, List<Map<String, Object>>> autos = new HashMap<>();
            for (Map.Entry<String, List<ApprovalStore.Row>> entry : store.forMessages(ids).entrySet()) {
                List<Map<String, Object>> list = new ArrayList<>();
                List<Map<String, Object>> unasked = new ArrayList<>();
                for (ApprovalStore.Row row : entry.getValue()) {
                    // A call done without asking is in the reply's approvals too, decidedBy auto, so the app has its
                    // place and payload for its line and its Undo; never a card.
                    list.add(view(row, false));
                    if (row.auto()) {
                        unasked.add(autoLine(row));
                    }
                }
                if (!list.isEmpty()) {
                    views.put(entry.getKey(), list);
                }
                if (!unasked.isEmpty()) {
                    autos.put(entry.getKey(), unasked);
                }
            }
            return new Decor(views, store.marks(ids), autos);
        } catch (SQLException e) {
            log.warn("approvals weren't read: {}", e.getClass().getSimpleName());
            return Decor.NONE;
        }
    }

    /**
     * A reply's view, as §18 adds to it: {@code approvals}; while its run waits, {@code state: "awaiting_approval"}
     * and {@code pendingApprovals}; {@code untrusted} and {@code egressCount} from its run, live or as kept.
     */
    public void decorate(Map<String, Object> view, MessageRow row, Decor decor) {
        if (!"assistant".equals(row.role())) {
            return;
        }
        Decor d = decor == null ? decor(List.of(row)) : decor;
        List<Map<String, Object>> approvals = d.approvals().get(row.id());
        if (approvals != null) {
            view.put("approvals", approvals);
        }
        List<Map<String, Object>> unasked = d.auto().get(row.id());
        if (unasked != null) {
            view.put("auto", unasked);
        }
        boolean untrusted = false;
        int egress = 0;
        RunContext live = "streaming".equals(row.state()) && row.runId() != null ? run(row.runId()) : null;
        if (live != null) {
            untrusted = live.untrusted();
            List<String> waiting = pendingOf(row.runId());
            if (!waiting.isEmpty()) {
                view.put("state", "awaiting_approval");
                view.put("pendingApprovals", waiting);
            }
            lock.lock();
            try {
                Book book = books.get(row.runId());
                egress = book == null ? 0 : book.egress;
            } finally {
                lock.unlock();
            }
        } else {
            ApprovalStore.Marks marks = d.marks().get(row.id());
            if (marks != null) {
                untrusted = marks.untrusted();
                egress = marks.egress();
            }
        }
        if (untrusted) {
            view.put("untrusted", true);
        }
        if (egress > 0) {
            view.put("egressCount", egress);
        }
    }

    /**
     * The flags a run starts with from its thread: a reply in its context whose run held U (or S) carries it forward,
     * as the model reads that reply again.
     */
    public Set<Taint> carried(Collection<MessageRow> context) {
        if (!any) {
            return Set.of();
        }
        List<String> ids = new ArrayList<>();
        for (MessageRow row : context) {
            if ("assistant".equals(row.role())) {
                ids.add(row.id());
            }
        }
        Set<Taint> taint = java.util.EnumSet.noneOf(Taint.class);
        try {
            for (ApprovalStore.Marks marks : store.marks(ids).values()) {
                if (marks.untrusted()) {
                    taint.add(Taint.U);
                }
                if (marks.privateData()) {
                    taint.add(Taint.S);
                }
            }
        } catch (SQLException e) {
            // Unknown is untrusted: a thread whose marks can't be read starts as if it had both.
            log.warn("a thread's marks weren't read: {}", e.getClass().getSimpleName());
            return Set.of(Taint.U, Taint.S);
        }
        return taint;
    }

    // ---------------------------------------------------------------- RPCs

    public static boolean handles(String method) {
        return method.equals("agent.approvals.list") || method.equals("agent.approval.get")
                || method.equals("agent.approval.decide") || method.equals(UNDO);
    }

    /** The member's undo of a call done without asking, as deskd relays it once it has done it (the draft ADR's §15). */
    public static final String UNDO = "agent.approval.undo";

    public Map<String, Object> call(String method, Map<String, Object> p, Caller caller) throws RpcError, SQLException {
        return switch (method) {
            case "agent.approvals.list" -> list(p, caller);
            case "agent.approval.get" -> Map.of("approval", view(visible(id(p), caller), true));
            case "agent.approval.decide" -> decide(p, caller);
            case UNDO -> undone(p, caller);
            default -> throw RpcError.of("not_found", "detail", "method");
        };
    }

    /** The approval, if this caller may see it; else {@code not_found}, as one that doesn't exist. */
    private ApprovalStore.Row visible(String id, Caller caller) throws RpcError, SQLException {
        ApprovalStore.Row row = store.get(id);
        if (row == null || !caller.sees(row.agentId())) {
            throw RpcError.notFound("approval");
        }
        return row;
    }

    private Map<String, Object> list(Map<String, Object> p, Caller caller) throws RpcError, SQLException {
        String agentId = null;
        if (p.get("agentId") != null) {
            if (!(p.get("agentId") instanceof String id) || !AGENT_ID.matcher(id).matches()) {
                throw RpcError.badRequest("agentId");
            }
            if (!caller.sees(id)) {
                throw RpcError.notFound("agent");
            }
            agentId = id;
        }
        boolean pendingOnly = true;
        if (p.get("state") != null) {
            if ("all".equals(p.get("state"))) {
                pendingOnly = false;
            } else if (!"pending".equals(p.get("state"))) {
                throw RpcError.badRequest("state");
            }
        }
        ApprovalStore.Row cursor = null;
        if (p.get("before") != null) {
            cursor = visible(id(p, "before"), caller);
            if (agentId != null && !agentId.equals(cursor.agentId())) {
                throw RpcError.notFound("approval");
            }
        }
        long now = clock.millis();
        List<Map<String, Object>> out = new ArrayList<>();
        int bytes = 0;
        boolean older = false;
        fill:
        while (true) {
            List<ApprovalStore.Row> rows = store.newestFirst(agentId, pendingOnly, cursor, now, LIST_PAGE);
            for (ApprovalStore.Row row : rows) {
                cursor = row;
                if (!caller.sees(row.agentId())) {
                    continue;
                }
                Map<String, Object> view = view(row, false);
                int size = Json.bytes(view).length + 1;
                if (out.size() == LIST_PAGE || bytes + size > LIST_BYTES) {
                    older = true;
                    break fill;
                }
                out.add(view);
                bytes += size;
            }
            if (rows.size() < LIST_PAGE) {
                break;
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("approvals", out);
        result.put("older", older);
        return result;
    }

    /**
     * {@code agent.approval.decide}: the member's yes or no for one card, which must carry the hash of the payload the
     * app showed. Only the agent's owner, through a session deskd let decide (it checked the token's input).
     */
    private Map<String, Object> decide(Map<String, Object> p, Caller caller) throws RpcError, SQLException {
        String id = id(p);
        if (!(p.get("approve") instanceof Boolean approve)) {
            throw RpcError.badRequest("approve");
        }
        if (!(p.get("sha256") instanceof String sha) || sha.length() != 64) {
            throw RpcError.badRequest("sha256");
        }
        String note = null;
        if (p.get("note") != null) {
            if (approve || !(p.get("note") instanceof String text) || text.isBlank()
                    || text.codePointCount(0, text.length()) > NOTE_MAX) {
                throw RpcError.badRequest("note");
            }
            TextChecks.refuseHidden(text, "note");
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                if (Character.isISOControl(c) && c != '\n' && c != '\t') {
                    throw RpcError.of("bad_request", "detail", "note", "reason", "hidden_chars");
                }
            }
            note = text;
        }
        ApprovalStore.Row row = visible(id, caller);
        if (!row.sha256().equalsIgnoreCase(sha)) {
            throw RpcError.badRequest("sha256");
        }
        if (row.state().equals("expired")) {
            throw RpcError.of("conflict", "reason", "expired");
        }
        if (!row.state().equals("pending")) {
            throw RpcError.of("conflict", "reason", "answered");
        }
        long now = clock.millis();
        Entry e;
        lock.lock();
        try {
            e = live.get(id);
            if (e == null || now >= e.expiresAt) {
                // Its run is gone, or its time is up: the waiting run expires it, if it's still there.
                changed.signalAll();
                throw RpcError.of("conflict", "reason", "expired");
            }
            if (!e.pending() || e.claimed) {
                throw RpcError.of("conflict", "reason", e.state.equals("expired") ? "expired" : "answered");
            }
            e.claimed = true;
        } finally {
            lock.unlock();
        }
        String state = approve ? "approved" : "declined";
        String by = caller.isMember() ? caller.memberId() : "owner";
        boolean moved = false;
        try {
            moved = store.decide(id, state, now, by, note);
        } finally {
            lock.lock();
            try {
                e.claimed = false;
                if (moved) {
                    e.state = state;
                    e.note = note;
                    Book book = books.get(e.runId);
                    if (!approve && book != null) {
                        book.declines++;
                        book.declinedHashes.add(e.sha256);
                    }
                }
                changed.signalAll();
            } finally {
                lock.unlock();
            }
        }
        if (!moved) {
            throw RpcError.of("conflict", "reason", "answered");
        }
        if (!approve) {
            bookChanged.accept(row.runId());
        }
        audit(caller.isMember() ? "member" : "user", "approval.decide", target(id, row.tool(), row.runId()),
                HexFormat.of().parseHex(row.sha256()), state);
        Map<String, Object> view = publish(id);
        host.state(row.agentId());
        return Map.of("approval", view == null ? view(store.get(id), true) : withPayload(view, id));
    }

    /**
     * {@code agent.approval.undo}, as deskd relays it: deskd has taken the call back itself, from its own ledger, through
     * the tool host (Files' trash, desk-notebook's undo of the edit), and says how that went: {@code outcome} {@code ok},
     * or the word it refused with ({@code changed}, {@code trashed}, …). This stamps the row once and audits it either
     * way; deskd builds these params itself and answers the member. Only a call done without asking by an agent the caller
     * may see.
     */
    private Map<String, Object> undone(Map<String, Object> p, Caller caller) throws RpcError, SQLException {
        String id = id(p);
        if (!(p.get("outcome") instanceof String outcome) || outcome.isBlank() || outcome.length() > 32) {
            throw RpcError.badRequest("outcome");
        }
        ApprovalStore.Row row = visible(id, caller);
        if (!row.auto()) {
            throw RpcError.notFound("approval");
        }
        String actor = caller.isMember() ? "member" : "user";
        if (!"ok".equals(outcome)) {
            audit(actor, "approval.undo", target(id, row.tool(), row.runId()), null, "refused:" + outcome);
            return Map.of("approval", view(row, true));
        }
        if (row.undoneAt() != null) {
            throw RpcError.of("conflict", "reason", "undone");
        }
        String by = caller.isMember() ? caller.memberId() : "owner";
        if (!store.undone(id, clock.millis(), by)) {
            throw RpcError.of("conflict", "reason", "undone");
        }
        audit(actor, "approval.undo", target(id, row.tool(), row.runId()), HexFormat.of().parseHex(row.sha256()), "ok");
        recountUnseen(row.agentId());
        Map<String, Object> view = publish(id);
        return Map.of("approval", view == null ? view(store.get(id), true) : withPayload(view, id));
    }

    /** How many calls done without asking in runs the member didn't start wait to be seen: the agent's {@code autoUnseen}. */
    public int autoUnseen(String agentId) {
        return autoUnseen.getOrDefault(agentId, 0);
    }

    /** The member has seen the agent's thread: its calls done without asking aren't counted any more. */
    public void seen(String agentId) {
        if (autoUnseen.remove(agentId) == null) {
            return;
        }
        try {
            store.markSeen(agentId);
        } catch (SQLException e) {
            log.warn("calls done without asking weren't marked seen: {}", e.getClass().getSimpleName());
        }
    }

    private void recountUnseen(String agentId) {
        try {
            Integer n = store.autoUnseen(agentId).get(agentId);
            if (n == null || n == 0) {
                autoUnseen.remove(agentId);
            } else {
                autoUnseen.put(agentId, n);
            }
        } catch (SQLException e) {
            log.warn("an agent's unseen calls weren't counted: {}", e.getClass().getSimpleName());
        }
        host.state(agentId);
    }

    // ---------------------------------------------------------------- views

    /** Publishes an approval as it is now. @return its view, payload left out over 32 KiB, or null */
    private Map<String, Object> publish(String id) {
        try {
            ApprovalStore.Row row = store.get(id);
            if (row == null) {
                return null;
            }
            Map<String, Object> view = view(row, false);
            host.approval(row.agentId(), view);
            return view;
        } catch (SQLException e) {
            log.warn("an approval wasn't published: {}", e.getClass().getSimpleName());
            return null;
        }
    }

    private Map<String, Object> withPayload(Map<String, Object> view, String id) throws SQLException {
        if (!Boolean.TRUE.equals(view.get("payloadOmitted"))) {
            return view;
        }
        return view(store.get(id), true);
    }

    /** An approval as §18 has it. A pending one past its time reads {@code expired}, {@code timeout}. */
    Map<String, Object> view(ApprovalStore.Row row, boolean wholePayload) {
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("id", row.id());
        v.put("agentId", row.agentId());
        v.put("runId", row.runId());
        v.put("messageId", row.messageId());
        v.put("tool", row.tool());
        v.put("risk", row.risk());
        v.put("title", row.title());
        v.put("context", row.context());
        v.put("target", parse(row.target()));
        int payloadBytes = row.payload().getBytes(StandardCharsets.UTF_8).length;
        boolean omitted = !wholePayload && payloadBytes > EVENT_PAYLOAD_MAX;
        v.put("payload", omitted ? null : parse(row.payload()));
        v.put("payloadOmitted", omitted);
        v.put("payloadBytes", payloadBytes);
        v.put("before", row.before() == null ? null : parse(row.before()));
        v.put("sha256", row.sha256());
        v.put("untrusted", row.untrusted());
        v.put("origin", parse(row.origin()));
        String state = row.state();
        String detail = row.detail();
        if (state.equals("pending") && clock.millis() >= row.expiresAt()) {
            state = "expired";
            detail = "timeout";
        }
        v.put("state", state);
        v.put("detail", detail);
        v.put("createdAt", row.createdAt());
        v.put("expiresAt", row.expiresAt());
        v.put("decidedAt", row.decidedAt());
        v.put("decidedBy", row.decidedBy());
        v.put("note", row.note());
        v.put("result", row.result() == null ? null : parse(row.result()));
        v.put("auto", row.auto() ? autoOf(row) : null);
        v.put("undoneAt", row.undoneAt());
        v.put("undoneBy", row.undoneBy());
        return v;
    }

    /** A call done without asking's {@code auto}: {@code {group, tabId?, folder?}}. */
    private static Map<String, Object> autoOf(ApprovalStore.Row row) {
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> place = parse(row.autoPlace());
        out.put("group", row.autoGroup());
        if (place != null && place.get("tabId") instanceof String tab) {
            out.put("tabId", tab);
        }
        if (place != null && place.get("folder") instanceof String folder) {
            out.put("folder", folder);
        }
        return out;
    }

    /** One line of a reply's {@code auto}: {@code {approvalId, tool, target, group, state, undoneAt}}. */
    private Map<String, Object> autoLine(ApprovalStore.Row row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("approvalId", row.id());
        out.put("tool", row.tool());
        out.put("target", parse(row.target()));
        out.put("group", row.autoGroup());
        out.put("state", row.state());
        out.put("undoneAt", row.undoneAt());
        return out;
    }

    // ---------------------------------------------------------------- helpers

    /** The word a failed tool's text starts with ("Refused: changed.", "Interrupted: lost."), or {@code failed}. */
    static String errorWord(ToolResult result) {
        return com.minimalistalliance.desk.agent.tool.Restart.word(result);
    }

    /** A run call's audit decision: {@code ok}, {@code error:<word>}, or {@code interrupted:<word>} when it may have happened. */
    private static String outcome(ToolResult result) {
        if (!result.error()) {
            return "ok";
        }
        return (com.minimalistalliance.desk.agent.tool.Restart.interrupted(result) ? "interrupted:" : "error:")
                + errorWord(result);
    }

    private static byte[] payloadHash(Classified call) {
        try {
            return HexFormat.of().parseHex(Canonical.sha256(call.payload()));
        } catch (IllegalArgumentException | ClassCastException e) {
            return AuditLog.sha256(Json.bytes(call.payload()));
        }
    }

    private static String target(String approvalId, String tool, String runId) {
        return "approval:" + approvalId + " tool:" + clip(tool, 64) + " run:" + clip(runId, 64);
    }

    private static String clip(String text, int max) {
        String plain = text.replaceAll("\\p{Cntrl}", "");
        return plain.length() > max ? plain.substring(0, max) : plain;
    }

    private void audit(String actor, String action, String target, byte[] payloadSha256, String decision) {
        try {
            audit.append(new AuditLog.Entry(actor, action, target, payloadSha256, word(decision), null));
        } catch (SQLException | RuntimeException e) {
            log.warn("an audit row wasn't written: {} {}", action, e.getClass().getSimpleName());
        }
    }

    private static String word(String text) {
        String w = text == null ? "none" : text.toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9_.:-]", "_");
        if (w.isEmpty() || !Character.isLetter(w.charAt(0))) {
            w = "x" + w;
        }
        return w.length() > 64 ? w.substring(0, 64) : w;
    }

    private static String id(Map<String, Object> p) throws RpcError {
        return id(p, "approvalId");
    }

    private static String id(Map<String, Object> p, String key) throws RpcError {
        if (!(p.get(key) instanceof String id) || !ID.matcher(id).matches()) {
            // A malformed id can't be anyone's.
            if (p.get(key) instanceof String) {
                throw RpcError.notFound("approval");
            }
            throw RpcError.badRequest(key);
        }
        return id;
    }

    static String newId() {
        char[] id = new char[20];
        for (int i = 0; i < id.length; i++) {
            id[i] = BASE32[RANDOM.nextInt(32)];
        }
        return "ap-" + new String(id);
    }

    private static String text(Object value) {
        return new String(Json.bytes(value), StandardCharsets.UTF_8);
    }

    private static Map<String, Object> parse(String json) {
        if (json == null) {
            return null;
        }
        try {
            return Json.parseObject(json.getBytes(StandardCharsets.UTF_8));
        } catch (JsonFormatException e) {
            return Map.of();
        }
    }

    /** No content in logs. */
    @Override
    public String toString() {
        return "Approvals[" + live.size() + " live]";
    }
}
