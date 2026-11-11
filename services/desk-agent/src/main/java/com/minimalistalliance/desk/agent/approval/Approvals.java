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
import java.util.regex.Matcher;
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
 * started). A stop interrupts it, and its pending approvals expire {@code stopped} (or {@code age_band}, or
 * {@code restart} on the way down). Nothing about a wait survives the process: {@link #restore} sweeps what a restart
 * left.
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
    private static final Pattern RESULT_WORD = Pattern.compile("(?:Refused|Failed): ([a-z][a-z0-9_]{0,31})\\.");
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
        final Set<String> sites = new HashSet<>();
        final Map<String, Entry> entries = new LinkedHashMap<>();
        /** Why the desk is ending this run, when it is: {@code age_band}, {@code restart}; null for a member's stop. */
        String endDetail;

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

    public Approvals(AgentStore agents, AuditLog audit, Clock clock) {
        this.store = new ApprovalStore(agents);
        this.audit = audit;
        this.clock = clock;
    }

    public void attach(Host newHost) {
        this.host = newHost;
    }

    // ---------------------------------------------------------------- the run's side

    /**
     * After {@code agent.db} opens, with no run going: what a restart left. Pending approvals and approved ones whose
     * tool never started become {@code expired} with {@code detail: "restart"}; approved ones whose tool had started
     * become {@code interrupted}, as deskd finishes a call it already began. Nothing re-runs.
     */
    public void restore() throws SQLException {
        long now = clock.millis();
        for (ApprovalStore.Row row : store.sweepAtOpen(now)) {
            boolean interrupted = row.state().equals("approved") && row.startedAt() != null;
            audit("agent:" + row.agentId(), interrupted ? "approval.interrupt" : "approval.expire",
                    target(row.id(), row.tool(), row.runId()), null, "restart");
        }
        any = !store.newestFirst(null, false, null, now, 1).isEmpty() || store.anyMarks();
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
        Verdict[] out = new Verdict[step.size()];
        List<Integer> asking = new ArrayList<>();
        Map<Integer, String> hashes = new HashMap<>();
        Map<Integer, String> payloads = new HashMap<>();
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
            Set<String> sites = new HashSet<>(book.sites);
            for (int i = 0; i < step.size(); i++) {
                Classified call = step.get(i);
                book.toolCalls++;
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
        if (asking.isEmpty()) {
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
            store.insert(rows);
            any = true;
        } catch (SQLException e) {
            log.warn("approvals weren't recorded: {}", e.getClass().getSimpleName());
            for (int i : asking) {
                out[i] = new Verdict.Refused("storage");
            }
            return List.of(out);
        }
        List<Entry> mine = new ArrayList<>();
        lock.lock();
        try {
            Book book = books.computeIfAbsent(run.runId(), id -> new Book(run));
            for (ApprovalStore.Row row : rows) {
                Entry e = new Entry(row.id(), row.agentId(), row.runId(), row.messageId(), row.tool(), row.sha256(),
                        row.expiresAt());
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
            for (int k = 0; k < asking.size(); k++) {
                Entry e = mine.get(k);
                out[asking.get(k)] = switch (e.state) {
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
        audit("agent:" + e.agentId, "approval.expire", target(e.id, e.tool, e.runId), null, detail);
        publish(e.id);
    }

    /** Just before an approved call's tool runs: from here a restart makes it {@code interrupted}, not expired. */
    @Override
    public void starting(Verdict verdict) {
        if (!(verdict instanceof Verdict.Approved approved)) {
            return;
        }
        lock.lock();
        try {
            Entry e = live.get(approved.approvalId());
            if (e != null) {
                e.started = true;
            }
        } finally {
            lock.unlock();
        }
        try {
            store.started(approved.approvalId(), clock.millis());
        } catch (SQLException e) {
            log.warn("an approval's start wasn't recorded: {}", e.getClass().getSimpleName());
        }
    }

    @Override
    public void settle(Verdict verdict, ToolResult result) {
        if (!(verdict instanceof Verdict.Approved approved)) {
            return;
        }
        String error = result.error() ? errorWord(result) : null;
        Map<String, Object> outcome = new LinkedHashMap<>();
        outcome.put("ok", !result.error());
        if (error != null) {
            outcome.put("error", error);
        }
        try {
            store.settle(approved.approvalId(), result.error() ? "failed" : "done", text(outcome));
        } catch (SQLException e) {
            log.warn("an approval's outcome wasn't recorded: {}", e.getClass().getSimpleName());
        }
        lock.lock();
        try {
            Entry e = live.remove(approved.approvalId());
            if (e != null) {
                e.state = result.error() ? "failed" : "done";
                Book book = books.get(e.runId);
                if (book != null) {
                    book.entries.remove(e.id);
                }
            }
        } finally {
            lock.unlock();
        }
        publish(approved.approvalId());
    }

    /**
     * The call's audit row and its approval's outcome: {@code tool.call} with the payload's hash, and
     * {@code browser.session.grant} when the member's session was granted. Counts the run's {@code egress} calls.
     */
    @Override
    public void settle(RunContext run, Classified call, Verdict verdict, ToolResult result) {
        String decision;
        String approvalId = null;
        switch (verdict) {
            case Verdict.Auto a -> decision = result.error() ? "error:" + errorWord(result) : "ok";
            case Verdict.Approved a -> {
                approvalId = a.approvalId();
                decision = result.error() ? "error:" + errorWord(result) : "ok";
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
                + (approvalId == null ? "" : " approval:" + approvalId);
        audit("agent:" + run.agentId(), "tool.call", target, payloadHash(call), decision);
        if (verdict.runs() && call.risk() == Risk.EGRESS) {
            lock.lock();
            try {
                Book book = books.get(run.runId());
                if (book != null) {
                    book.egress++;
                }
            } finally {
                lock.unlock();
            }
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
        Book book;
        List<Entry> open = new ArrayList<>();
        List<Entry> interrupted = new ArrayList<>();
        lock.lock();
        try {
            book = books.get(runId);
            if (book == null) {
                return;
            }
            for (Entry e : book.entries.values()) {
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

    /** The approvals and marks of a page's replies, read at once. */
    public record Decor(Map<String, List<Map<String, Object>>> approvals, Map<String, ApprovalStore.Marks> marks) {
        static final Decor NONE = new Decor(Map.of(), Map.of());
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
            for (Map.Entry<String, List<ApprovalStore.Row>> entry : store.forMessages(ids).entrySet()) {
                List<Map<String, Object>> list = new ArrayList<>();
                for (ApprovalStore.Row row : entry.getValue()) {
                    list.add(view(row, false));
                }
                views.put(entry.getKey(), list);
            }
            return new Decor(views, store.marks(ids));
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
                || method.equals("agent.approval.decide");
    }

    public Map<String, Object> call(String method, Map<String, Object> p, Caller caller) throws RpcError, SQLException {
        return switch (method) {
            case "agent.approvals.list" -> list(p, caller);
            case "agent.approval.get" -> Map.of("approval", view(visible(id(p), caller), true));
            case "agent.approval.decide" -> decide(p, caller);
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
        audit(caller.isMember() ? "member" : "user", "approval.decide", target(id, row.tool(), row.runId()),
                HexFormat.of().parseHex(row.sha256()), state);
        Map<String, Object> view = publish(id);
        host.state(row.agentId());
        return Map.of("approval", view == null ? view(store.get(id), true) : withPayload(view, id));
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
        return v;
    }

    // ---------------------------------------------------------------- helpers

    /** The word a failed tool's text starts with ("Refused: changed."), or {@code failed}. Never content. */
    static String errorWord(ToolResult result) {
        Matcher m = RESULT_WORD.matcher(result.content());
        return m.lookingAt() ? m.group(1) : "failed";
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
